"""Missing, failed, skipped and unexpected dependency results must fail the gate."""
import contextlib, io, json, os, pathlib, runpy, tempfile, unittest
from unittest.mock import patch
class Gate(unittest.TestCase):
    def check(self,expected,needs,code):
        with tempfile.TemporaryDirectory() as directory:
            summary=pathlib.Path(directory)/'summary'
            env=dict(EXPECTED_LEGS=json.dumps(expected),NEEDS_JSON=json.dumps(needs),GITHUB_STEP_SUMMARY=str(summary))
            with patch.dict(os.environ,env),contextlib.redirect_stdout(io.StringIO()),self.assertRaises(SystemExit) as result:
                runpy.run_path(str(pathlib.Path(__file__).with_name('ci-gate.py')),run_name='__main__')
            self.assertEqual(result.exception.code,code)
            if expected:
                for label in expected.values():self.assertIn(label,summary.read_text())
    def test_all_success(self):self.check({'a':'OS A','b':'OS B'},{key:{'result':'success'} for key in ('a','b')},0)
    def test_failures_are_not_hidden(self):
        for status in ('failure','cancelled','skipped',None):
            with self.subTest(status=status):self.check({'a':'OS A'},{'a':{'result':status}},1)
    def test_missing(self):self.check({'a':'OS A'},{},1)
    def test_unexpected(self):self.check({'a':'OS A'},{key:{'result':'success'} for key in ('a','extra')},1)
    def test_empty(self):self.check({}, {},'expected legs must be nonempty')
if __name__=='__main__':unittest.main()
