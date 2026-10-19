"""Matrix gate must not hide absent, failed, skipped, duplicate or extra legs."""
import contextlib, io, json, os, pathlib, runpy, tempfile, unittest
from unittest.mock import patch
class Gate(unittest.TestCase):
    def check(self,expected,jobs,code):
        with tempfile.TemporaryDirectory() as directory:
            summary=pathlib.Path(directory)/'summary'
            env=dict(GITHUB_REPOSITORY='test/repo',GITHUB_RUN_ID='1',GITHUB_RUN_ATTEMPT='1',GH_TOKEN='test-only',EXPECTED_LEGS=json.dumps(expected),GITHUB_STEP_SUMMARY=str(summary))
            response=io.BytesIO(json.dumps({'jobs':jobs}).encode())
            with patch.dict(os.environ,env),patch('urllib.request.urlopen',return_value=response),contextlib.redirect_stdout(io.StringIO()),self.assertRaises(SystemExit) as result:
                runpy.run_path(str(pathlib.Path(__file__).with_name('ci-gate.py')),run_name='__main__')
            self.assertEqual(result.exception.code,code)
            if expected:
                for name in expected:self.assertIn(name,summary.read_text())
    def test_all_success(self):self.check(['A','B'],[dict(name=n,conclusion='success',html_url='https://example.test/'+n) for n in ('A','B')],0)
    def test_failures_are_not_hidden(self):
        for status in ('failure','cancelled','skipped',None):
            with self.subTest(status=status):self.check(['A'],[dict(name='A',conclusion=status,html_url='https://example.test/A')],1)
    def test_missing(self):self.check(['A'],[],1)
    def test_duplicate(self):self.check(['A'],[dict(name='A',conclusion='success',html_url='https://example.test/A')]*2,1)
    def test_unexpected(self):self.check(['A'],[dict(name=n,conclusion='success',html_url='https://example.test/'+n) for n in ('A','extra')],1)
    def test_empty(self):self.check([],[],'expected legs must be nonempty and unique')
if __name__=='__main__':unittest.main()
