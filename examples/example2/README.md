# example2: resume a session across one-shot commands

`miniplayer run --session new --json <prompt>` starts a stored conversation and prints
`{"sessionId", "text"}`. `miniplayer run --session <id> ...` continues it in a new process: the history is
rebuilt from the stored turns (same working directory only).

`session-sum.lms` gives a number, resumes with another, then asks for the total:

    lmscript session-sum.lms deepseek/deepseek-flash

Output of a real run:

    1: OK
    2: OK
    3: 12
    same session

Without `--json` the answer goes to stdout and `session: <id>` to stderr. Tool steps are not part of the
resumed history. Scripting through the ACP path (`lm_agent`) is still under development; this example uses
the one-shot command.
