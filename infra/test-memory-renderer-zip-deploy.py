#!/usr/bin/env python3
"""Offline checks for the no-local-Docker ZIP/layer deployment route."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / 'deploy-memory-renderer-zip.py'
spec = importlib.util.spec_from_file_location('reverie_memory_renderer_zip', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RendererZipDeploymentTests(unittest.TestCase):
    def test_build_source_contains_only_explicit_application_and_build_files(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'source.zip'
            module.build_source_zip(path)
            with zipfile.ZipFile(path) as bundle:
                self.assertEqual(set(bundle.namelist()), set(module.PACKAGE_FILES))
                self.assertNotIn('.resource-ids.env', '\n'.join(bundle.namelist()))
                self.assertIn('memory_export_worker.py', bundle.namelist())
                self.assertIn('buildspec.yml', bundle.namelist())

    def test_renderer_access_is_scoped_to_existing_data_paths(self):
        policy = module.renderer_policy('arn:aws:dynamodb:us-east-1:111111111111:table/test', 'private-test')
        self.assertFalse(any('s3:DeleteBucket' in str(x) or 'dynamodb:DeleteTable' in str(x)
                             for x in policy['Statement']))
        self.assertTrue(any('exports/*' in str(x) for x in policy['Statement']))
        self.assertTrue(any('transcripts/*' in str(x) for x in policy['Statement']))

    def test_build_spec_has_no_docker_or_ecr_commands(self):
        content = (HERE / 'memory-renderer-zip' / 'buildspec.yml').read_text()
        self.assertNotIn('docker ', content)
        self.assertNotIn('ecr ', content)
        self.assertIn('package_renderer.py', content)
        self.assertIn('build/layer.zip', content)


if __name__ == '__main__':
    unittest.main()
