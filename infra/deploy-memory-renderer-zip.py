#!/usr/bin/env python3
"""Docker-free (locally) PDF renderer deploy: CodeBuild -> Lambda ZIP + layer.

Uses only Python stdlib and AWS CLI on the user's WSL host. Does NOT touch
existing journal records, photos, PDFs, or the web/Lambda results backend.
Requires an explicit --deploy flag; --prepare performs no AWS calls.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile

REPO = Path(__file__).resolve().parent.parent
INFRA = REPO / 'infra'
PACKAGE_FILES = {
    'buildspec.yml': INFRA / 'memory-renderer-zip' / 'buildspec.yml',
    'package_renderer.py': INFRA / 'memory-renderer-zip' / 'package_renderer.py',
    'memory_export_worker.py': INFRA / 'lambda' / 'memory_export_worker.py',
    'journal_pages.py': INFRA / 'lambda' / 'journal_pages.py',
    'memory-book-templates.json': INFRA / 'lambda' / 'memory-book-templates.json',
}
DEFAULT_PREFIX = 'infra-builds/memory-renderer'


def fail(message: str):
    raise SystemExit(f'ERROR: {message}')


def run(*args: str, capture=True, allow_fail=False) -> str | None:
    p = subprocess.run(list(args), stdout=subprocess.PIPE if capture else None,
                       stderr=subprocess.PIPE if capture else None, text=True)
    if p.returncode:
        if allow_fail:
            return None
        detail = (p.stderr or p.stdout or '').strip()
        raise RuntimeError(f'{" ".join(args[:5])} failed: {detail}')
    return p.stdout.strip() if capture else ''


def aws(*args: str, allow_fail=False):
    raw = run('aws', *args, '--output', 'json', allow_fail=allow_fail)
    if raw is None:
        return None
    return json.loads(raw) if raw else None


def aws_text(*args: str, allow_fail=False):
    return run('aws', *args, '--output', 'text', allow_fail=allow_fail)


def tempjson(root: Path, name: str, data: object) -> str:
    path = root / name
    path.write_text(json.dumps(data, indent=2), encoding='utf-8')
    return 'file://' + str(path)


def build_source_zip(path: Path):
    for name, source in PACKAGE_FILES.items():
        if not source.is_file():
            fail(f'Missing required file: {source}')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for name, source in PACKAGE_FILES.items():
            bundle.write(source, name)
    with zipfile.ZipFile(path) as bundle:
        assert set(bundle.namelist()) == set(PACKAGE_FILES)
    print(f'Prepared source bundle: {len(PACKAGE_FILES)} files, {path.stat().st_size:,} bytes')
    print('Build target: Python 3.12 / Amazon Linux 2023 / x86_64 / Lambda ZIP + layer')


def create_codebuild_role(root: Path, name: str, region: str, account: str, bucket: str,
                          prefix: str) -> str:
    trust = {'Version': '2012-10-17', 'Statement': [{
        'Effect': 'Allow', 'Principal': {'Service': 'codebuild.amazonaws.com'},
        'Action': 'sts:AssumeRole'}]}
    existing = aws('iam', 'get-role', '--role-name', name, allow_fail=True)
    if existing is None:
        print(f'Creating scoped CodeBuild role {name}')
        aws('iam', 'create-role', '--role-name', name,
            '--assume-role-policy-document', tempjson(root, 'codebuild-trust.json', trust))
        # New IAM roles are eventually consistent before CodeBuild can assume them.
    else:
        policy = existing['Role'].get('AssumeRolePolicyDocument', {})
        if 'codebuild.amazonaws.com' not in json.dumps(policy):
            fail(f'Existing role {name} does not trust CodeBuild; refusing to repurpose it')
    log_arn = f'arn:aws:logs:{region}:{account}:log-group:/aws/codebuild/{name.replace("-role-", "-")}'
    policy = {'Version': '2012-10-17', 'Statement': [
        {'Effect': 'Allow', 'Action': ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'],
         'Resource': f'arn:aws:s3:::{bucket}/{prefix}/*'},
        {'Effect': 'Allow', 'Action': ['s3:GetBucketLocation'], 'Resource': f'arn:aws:s3:::{bucket}'},
        {'Effect': 'Allow', 'Action': ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
         'Resource': [f'arn:aws:logs:{region}:{account}:log-group:/aws/codebuild/*']},
    ]}
    aws('iam', 'put-role-policy', '--role-name', name, '--policy-name',
        'ReverieMemoryRendererBuild', '--policy-document', tempjson(root, 'codebuild-policy.json', policy))
    return aws('iam', 'get-role', '--role-name', name)['Role']['Arn']


def ensure_project(root: Path, name: str, role_arn: str, bucket: str, prefix: str,
                   source_key: str):
    existing = aws('codebuild', 'batch-get-projects', '--names', name)
    projects = existing.get('projects') or []
    project = {'name': name,
               'description': 'Build Reverie PDF Lambda ZIP and AL2023 native dependency layer; no ECR or local Docker.',
               'source': {'type': 'S3', 'location': f'{bucket}/{source_key}', 'buildspec': 'buildspec.yml'},
               'artifacts': {'type': 'NO_ARTIFACTS'},
               'environment': {'type': 'LINUX_CONTAINER',
                               'image': 'aws/codebuild/amazonlinux-x86_64-standard:5.0',
                               'computeType': 'BUILD_GENERAL1_SMALL',
                               'privilegedMode': False,
                               'environmentVariables': [
                                   {'name': 'BUILD_BUCKET', 'value': bucket, 'type': 'PLAINTEXT'},
                                   {'name': 'BUILD_PREFIX', 'value': prefix, 'type': 'PLAINTEXT'}]},
               'serviceRole': role_arn,
               'timeoutInMinutes': 35,
               'logsConfig': {'cloudWatchLogs': {'status': 'ENABLED',
                                               'groupName': f'/aws/codebuild/{name}'}}}
    config_file = tempjson(root, 'codebuild-project.json', project)
    if projects:
        old = projects[0]
        if old.get('source', {}).get('type') != 'S3':
            fail(f'CodeBuild project {name} exists with a different source. Refusing to overwrite it.')
        print(f'Updating deployment-specific CodeBuild project {name}')
        aws('codebuild', 'update-project', '--cli-input-json', config_file)
    else:
        print(f'Creating deployment-specific CodeBuild project {name}')
        aws('codebuild', 'create-project', '--cli-input-json', config_file)


def wait_for_build(project: str) -> str:
    started = aws('codebuild', 'start-build', '--project-name', project)
    build_id = started['build']['id']
    print(f'CodeBuild started: {build_id}\nAwaiting PDF packaging and smoke test...')
    while True:
        time.sleep(10)
        build = aws('codebuild', 'batch-get-builds', '--ids', build_id)['builds'][0]
        status = build.get('buildStatus', 'UNKNOWN')
        if status == 'SUCCEEDED':
            print('CodeBuild succeeded: native dependencies and sample PDF verified.')
            return build_id
        if status in ('FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'):
            log = build.get('logs', {}).get('deepLink') or '(see CloudWatch CodeBuild logs)'
            fail(f'CodeBuild {status}; renderer Lambda NOT changed. Logs: {log}')


def renderer_policy(table_arn: str, bucket: str):
    return {'Version': '2012-10-17', 'Statement': [
        {'Effect': 'Allow', 'Action': ['dynamodb:GetItem', 'dynamodb:UpdateItem'], 'Resource': table_arn},
        {'Effect': 'Allow', 'Action': 'dynamodb:DeleteItem', 'Resource': table_arn,
         'Condition': {'ForAllValues:StringLike': {'dynamodb:LeadingKeys': ['memory-export#*']}}},
        {'Effect': 'Allow', 'Action': 's3:GetObject', 'Resource': [
            f'arn:aws:s3:::{bucket}/uploads/*/memory-photos/*',
            f'arn:aws:s3:::{bucket}/photos/*', f'arn:aws:s3:::{bucket}/transcripts/*']},
        {'Effect': 'Allow', 'Action': 's3:DeleteObject',
         'Resource': f'arn:aws:s3:::{bucket}/uploads/*/memory-photos/*'},
        {'Effect': 'Allow', 'Action': ['s3:DeleteObject', 's3:DeleteObjectVersion'],
         'Resource': f'arn:aws:s3:::{bucket}/exports/*/*.pdf'},
        {'Effect': 'Allow', 'Action': 's3:PutObject',
         'Resource': [f'arn:aws:s3:::{bucket}/exports/*', f'arn:aws:s3:::{bucket}/photos/*']},
        {'Effect': 'Allow', 'Action': ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
         'Resource': '*'}]}


def ensure_renderer_role(root: Path, name: str, table_arn: str, bucket: str):
    response = aws('iam', 'get-role', '--role-name', name, allow_fail=True)
    if response is None:
        fail(f'Renderer IAM role {name} is missing. You created it earlier; verify AWS account and name.')
    role = response['Role']
    if 'lambda.amazonaws.com' not in json.dumps(role.get('AssumeRolePolicyDocument', {})):
        fail(f'Renderer role {name} does not trust Lambda; refusing to use it')
    aws('iam', 'put-role-policy', '--role-name', name,
        '--policy-name', 'ReverieMemoryRenderer',
        '--policy-document', tempjson(root, 'renderer-policy.json', renderer_policy(table_arn, bucket)))
    return role['Arn']


def deploy_lambda(root: Path, name: str, role_arn: str, layer_arn: str, bucket: str,
                  prefix: str, journal_table: str):
    env = {'Variables': {'JOURNAL_TABLE': journal_table, 'UPLOAD_BUCKET': bucket,
                         'FONTCONFIG_PATH': '/opt/etc/fonts',
                         'FONTCONFIG_FILE': '/opt/etc/fonts/fonts.conf',
                         'XDG_CACHE_HOME': '/tmp'}}
    env_file = tempjson(root, 'renderer-env.json', env)
    existing = aws('lambda', 'get-function-configuration', '--function-name', name, allow_fail=True)
    if existing is None:
        print(f'Creating ZIP-based renderer Lambda {name}')
        aws('lambda', 'create-function', '--function-name', name, '--runtime', 'python3.12',
            '--architectures', 'x86_64', '--handler', 'memory_export_worker.handler',
            '--role', role_arn, '--memory-size', '2048', '--timeout', '900',
            '--layers', layer_arn, '--code', f'S3Bucket={bucket},S3Key={prefix}/renderer.zip',
            '--environment', env_file)
        aws('lambda', 'wait', 'function-active-v2', '--function-name', name)
    else:
        if existing.get('PackageType') != 'Zip':
            fail(f'Lambda {name} is an image function; package type is immutable. Choose a new ZIP renderer name.')
        if existing.get('Handler') != 'memory_export_worker.handler':
            fail(f'Unexpected Lambda handler on {name}; refusing to overwrite it.')
        if existing.get('Role') != role_arn:
            fail(f'Existing ZIP renderer {name} has a different execution role; refusing to change its permissions implicitly.')
        print(f'Updating ZIP renderer Lambda {name}')
        aws('lambda', 'update-function-code', '--function-name', name,
            '--s3-bucket', bucket, '--s3-key', f'{prefix}/renderer.zip')
        aws('lambda', 'wait', 'function-updated-v2', '--function-name', name)
        aws('lambda', 'update-function-configuration', '--function-name', name,
            '--runtime', 'python3.12', '--layers', layer_arn,
            '--memory-size', '2048', '--timeout', '900', '--environment', env_file)
        aws('lambda', 'wait', 'function-updated-v2', '--function-name', name)
    config = aws('lambda', 'get-function-configuration', '--function-name', name)
    if (config.get('PackageType') != 'Zip' or config.get('State') != 'Active'
            or config.get('LastUpdateStatus') not in (None, 'Successful')):
        fail(f'Lambda deployment health check failed: {config.get("State")}/{config.get("LastUpdateStatus")}')
    if layer_arn not in [x['Arn'] for x in config.get('Layers', [])]:
        fail('Lambda did not attach the expected dependency layer')
    print(f'ZIP renderer deployed: {config["FunctionArn"]}')
    return config['FunctionArn']


def cleanup_staging(bucket: str, keys: list[str]):
    """Delete only the current build's exact keys (including versioned objects)."""
    for key in keys:
        head = aws('s3api', 'head-object', '--bucket', bucket, '--key', key, allow_fail=True)
        if head is None:
            continue
        version = head.get('VersionId')
        command = ['s3api', 'delete-object', '--bucket', bucket, '--key', key]
        if version and version != 'null':
            command += ['--version-id', version]
        aws(*command)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--prepare', action='store_true', help='Create source ZIP only; no AWS calls')
    mode.add_argument('--deploy', action='store_true', help='Build in CodeBuild and publish ZIP renderer Lambda')
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix='reverie-renderer-zip-') as folder:
        root = Path(folder)
        source = root / 'source.zip'
        build_source_zip(source)
        if args.prepare:
            print('Local packaging check PASSED. No AWS services called or changed.')
            return

        # Variables must come from the existing *.env files, as in the original deploy script.
        needed = ('AWS_ACCOUNT', 'AWS_REGION', 'JOURNAL_TABLE', 'JOURNAL_TABLE_ARN', 'UPLOAD_BUCKET')
        missing = [name for name in needed if not os.environ.get(name)]
        if missing:
            fail(f'Missing {missing}. Source infra/.resource-ids.env, .part2-resource-ids.env, .phase3-resource-ids.env first.')
        account = os.environ['AWS_ACCOUNT']; region = os.environ['AWS_REGION']
        table = os.environ['JOURNAL_TABLE']; table_arn = os.environ['JOURNAL_TABLE_ARN']
        bucket = os.environ['UPLOAD_BUCKET']
        if aws_text('sts', 'get-caller-identity', '--query', 'Account') != account:
            fail('Wrong AWS account; no deployment attempted')
        runtime_name = os.environ.get('MEMORY_RENDERER_NAME', f'reverie-memory-renderer-{account}')
        renderer_role = os.environ.get('MEMORY_RENDERER_ROLE_NAME', f'reverie-memory-renderer-role-{account}')
        project = os.environ.get('REVERIE_CODEBUILD_PROJECT', f'reverie-memory-renderer-build-{account}')
        build_role = os.environ.get('REVERIE_CODEBUILD_ROLE', f'reverie-memory-renderer-build-role-{account}')
        if not re.fullmatch(r'[A-Za-z0-9-_]{1,64}', runtime_name): fail('Invalid renderer name')
        if not re.fullmatch(r'[A-Za-z0-9-_]{1,255}', project): fail('Invalid project name')
        if not re.fullmatch(r'[A-Za-z0-9-_]{1,64}', build_role): fail('Invalid CodeBuild role name')
        prefix = f'{DEFAULT_PREFIX}/{uuid.uuid4().hex}'
        src_key = f'{prefix}/source.zip'
        keys = [f'{prefix}/{name}' for name in ('source.zip', 'renderer.zip', 'layer.zip', 'manifest.json')]
        print(f'Account: {account} | Region: {region} | Bucket: {bucket}')
        print(f'Renderer: {runtime_name} | CodeBuild: {project}')
        print('No Docker/ECR resources will be created. No journal data will be touched.')
        if os.environ.get('CONFIRM_MEMORY_RENDERER_ZIP') != 'YES':
            fail('Run with CONFIRM_MEMORY_RENDERER_ZIP=YES to authorize the AWS deployment')
        old = aws('lambda', 'get-function-configuration', '--function-name', runtime_name, allow_fail=True)
        if old and old.get('PackageType') != 'Zip':
            fail('Renderer with this name is already an Image Lambda; select a new name instead of replacing it')

        # Verify renderer role exists before spending anything on a build.
        iam_role = aws('iam', 'get-role', '--role-name', renderer_role, allow_fail=True)
        if not iam_role or 'lambda.amazonaws.com' not in json.dumps(iam_role['Role'].get('AssumeRolePolicyDocument', {})):
            fail('Renderer IAM role missing or lacks Lambda trust policy')
        build_role_arn = create_codebuild_role(root, build_role, region, account, bucket, DEFAULT_PREFIX)
        aws('s3api', 'put-object', '--bucket', bucket, '--key', src_key,
            '--body', str(source), '--server-side-encryption', 'AES256')
        ensure_project(root, project, build_role_arn, bucket, prefix, src_key)
        wait_for_build(project)
        for key in keys[1:]:
            result = aws('s3api', 'head-object', '--bucket', bucket, '--key', key)
            if not result.get('ContentLength', 0):
                fail(f'CodeBuild artifact is missing/empty: {key}')
        # Build and smoke test succeeded. IAM policy and live Lambda changes are now permitted.
        layer = aws('lambda', 'publish-layer-version',
                    '--layer-name', f'{runtime_name}-dependencies',
                    '--compatible-runtimes', 'python3.12', '--compatible-architectures', 'x86_64',
                    '--content', f'S3Bucket={bucket},S3Key={prefix}/layer.zip',
                    '--description', 'WeasyPrint 70/Pango/Pillow native dependencies built on Amazon Linux 2023')
        arn = ensure_renderer_role(root, renderer_role, table_arn, bucket)
        function_arn = deploy_lambda(root, runtime_name, arn, layer['LayerVersionArn'], bucket, prefix, table)
        print('Cleaning this build\'s temporary S3 upload artifacts (including versioned objects)...')
        cleanup_staging(bucket, keys)
        print('\nSUCCESS: renderer is deployed, no Docker/ECR. Next, run:')
        print(f'  export MEMORY_RENDERER_ARN="{function_arn}"')
        print('  CONFIRM_MEMORY_BOOKS_V1=YES bash infra/deploy-memory-book-v1.sh')
        print('Only run the backend deployment after checking the renderer configuration.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, KeyError, ValueError, subprocess.CalledProcessError) as exc:
        fail(str(exc))
