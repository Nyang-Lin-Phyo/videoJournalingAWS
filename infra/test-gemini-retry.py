"""Offline Gemini retry unit tests. No AWS or external network requests."""
import os,sys,unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
os.environ.update(AWS_ACCESS_KEY_ID='test',AWS_SECRET_ACCESS_KEY='test',AWS_EC2_METADATA_DISABLED='true',
                  AWS_DEFAULT_REGION='us-east-1',UPLOAD_BUCKET='fake-bucket',
                  ELEVENLABS_SECRET_ARN='test-secret',GEMINI_SECRET_ARN='test-secret',JOURNAL_TABLE='fake-table')
sys.path.insert(0,str(Path(__file__).parent/'lambda'))
import legacy_elevenlabs_provider as provider

class GeminiRetryTests(unittest.TestCase):
    def test_retryable_503_recovers(self):
        attempts=[]
        def fake_once(_transcript, _profile_context=None):
            attempts.append(1)
            if len(attempts)<3: raise RuntimeError('Gemini HTTP 503')
            return {'summary':'ok'}
        with patch.object(provider,'_analyze_transcript_once',fake_once),patch.object(provider.time,'sleep') as sl, patch.object(provider.random,'uniform',return_value=0.0):
            self.assertEqual(provider.analyze_transcript('transcript')['summary'],'ok')
            self.assertEqual([x.args[0] for x in sl.call_args_list],[5.0,10.0])
            self.assertEqual(len(attempts),3)
    def test_429_bounded_to_four_attempts(self):
        with patch.object(provider,'_analyze_transcript_once',side_effect=RuntimeError('Gemini HTTP 429')) as call,patch.object(provider.time,'sleep') as sl,patch.object(provider.random,'uniform',return_value=0.0):
            with self.assertRaisesRegex(RuntimeError,'Gemini HTTP 429'):
                provider.analyze_transcript('transcript')
            self.assertEqual(call.call_count,4)
            self.assertEqual([x.args[0] for x in sl.call_args_list],[5.0,10.0,20.0])
    def test_403_not_retried(self):
        with patch.object(provider,'_analyze_transcript_once',side_effect=RuntimeError('Gemini HTTP 403')) as call,patch.object(provider.time,'sleep') as sl:
            with self.assertRaisesRegex(RuntimeError,'Gemini HTTP 403'):
                provider.analyze_transcript('transcript')
            self.assertEqual(call.call_count,1)
            sl.assert_not_called()
    def test_network_error_retried(self):
        with patch.object(provider,'_analyze_transcript_once',side_effect=[RuntimeError('Gemini network error'),{'summary':'ok'}]), patch.object(provider.time,'sleep') as sl,patch.object(provider.random,'uniform',return_value=0.0):
            self.assertEqual(provider.analyze_transcript('transcript')['summary'],'ok')
            self.assertEqual(sl.call_args[0][0],5.0)

if __name__=='__main__': unittest.main(verbosity=2)
