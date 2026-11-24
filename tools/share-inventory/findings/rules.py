"""Name patterns that suggest a file or folder holds sensitive material.

These look at names only. A hit means "someone should check who can reach
this", not "this is sensitive": the file is never opened to confirm.

Patterns are deliberately conservative. Words that are sensitive in an office
but ordinary in a machine shop are left out: `termination` (wiring), `cv`
(valves), `hr` (hours), `compensation` (temperature), `.bak` (CAD backups),
`K-1` and `CVV` (part numbers), `wire instructions` (re-wiring).
A rule that floods the report gets ignored, which is worse than a missed word.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

HIGH, MEDIUM, LOW = "high", "medium", "low"
SEVERITY_ORDER = {HIGH: 0, MEDIUM: 1, LOW: 2}


@dataclass(frozen=True)
class Rule:
    id: str
    category: str
    severity: str
    pattern: re.Pattern[str]
    files_only: bool = False  # extension rules make no sense on folder names
    code_ok: bool = False  # also applies to source files (password.js is code, id_rsa is not)


def words(expr: str) -> re.Pattern[str]:
    """Match `expr` as whole words, where digits, `_` and `-` count as breaks.

    `\\b` would treat `payroll_2024` as one word and miss it.
    """
    return re.compile(rf"(?<![a-z])(?:{expr})(?![a-z])", re.I)


def ext(*extensions: str) -> re.Pattern[str]:
    return re.compile(r"\.(?:" + "|".join(extensions) + r")$", re.I)


S = r"[ _-]?"  # optional separator inside a phrase

RULES: tuple[Rule, ...] = (
    # ---- credentials -------------------------------------------------------
    Rule("password-in-name", "Credentials", HIGH, words(r"passwords?|passwd|credentials?")),
    Rule("password-store", "Credentials", HIGH, ext("kdbx?", "psafe3", "1pif"), files_only=True, code_ok=True),
    Rule(
        "private-key",
        "Credentials",
        HIGH,
        re.compile(r"\.(?:pfx|p12|pem|ppk|ovpn|jks)$|^id_(?:rsa|dsa|ecdsa|ed25519)$", re.I),
        files_only=True,
        code_ok=True,
    ),
    Rule("maybe-credentials", "Credentials", MEDIUM, words(r"pwd|creds|logins?|secrets?")),
    Rule(
        "config-with-secrets",
        "Credentials",
        MEDIUM,
        re.compile(r"^(?:\.env(?:\..+)?|\.npmrc|\.netrc|\.pgpass|web\.config|unattend\.xml|appsettings(?:\..+)?\.json)$", re.I),
        files_only=True,
        code_ok=True,
    ),
    # ---- people ------------------------------------------------------------
    Rule("payroll", "People", HIGH, words(rf"payroll|pay{S}stubs?|salar(?:y|ies)|garnishments?|direct{S}deposit")),
    Rule(
        "government-id",
        "People",
        HIGH,
        words(rf"ssn|social{S}security|passports?|driver'?s?{S}licen[sc]es?|birth{S}cert\w*"),
    ),
    Rule(
        "tax-form",
        "People",
        HIGH,
        # Hyphenated or spelled out only: a bare W2 or 1099 is a part or job number here.
        words(rf"(?:form{S})?(?:w-[249]|i-9)s?|form{S}(?:w[249]|i9|1099)|1099{S}(?:misc|nec|int|k)|w[249]{S}forms?"),
    ),
    Rule(
        "hr-document",
        "People",
        MEDIUM,
        words(
            rf"resumes?|offer{S}letters?|performance{S}reviews?|disciplin\w*|severance|background{S}checks?"
            rf"|drug{S}(?:test|screen)\w*|fmla|401{S}k|new{S}hires?|personnel|human{S}resources"
            rf"|employee{S}(?:files?|records?|reviews?|evaluations?)"
        ),
    ),
    Rule(
        "medical",
        "People",
        MEDIUM,
        words(rf"medical{S}(?:records?|leave|history)|doctor'?s?{S}notes?|workers?'?{S}comp\w*|injur(?:y|ies){S}reports?"),
    ),
    # ---- finance -----------------------------------------------------------
    Rule(
        "payment-card",
        "Finance",
        HIGH,
        words(rf"credit{S}cards?|debit{S}cards?|card{S}numbers?|cc{S}(?:info|numbers?|receipts?)"),
    ),
    Rule(
        "bank-details",
        "Finance",
        HIGH,
        words(
            rf"bank{S}(?:statements?|accounts?|info|details)|routing{S}numbers?|voided{S}checks?"
            rf"|wire{S}transfers?|ach{S}(?:forms?|info|details|authori[sz]ation)"
        ),
    ),
    Rule("tax-return", "Finance", MEDIUM, words(rf"tax{S}returns?|form{S}(?:941|940|1120|1065)")),
    Rule(
        "company-books",
        "Finance",
        MEDIUM,
        re.compile(
            rf"\.(?:qbw|qbb|qbm)$|(?<![a-z])(?:quickbooks|general{S}ledger|balance{S}sheets?"
            rf"|profit{S}(?:and|&|n){S}loss|p&l|income{S}statements?|financial{S}statements?)(?![a-z])",
            re.I,
        ),
    ),
    Rule("invoices-receipts", "Finance", LOW, words(rf"invoices?|receipts?|expense{S}reports?")),
    # ---- legal -------------------------------------------------------------
    Rule("nda", "Legal", MEDIUM, words(rf"nda|non{S}disclosure|confidentiality{S}agreements?")),
    Rule(
        "legal-matter",
        "Legal",
        MEDIUM,
        words(rf"lawsuits?|litigation|subpoenas?|settlement{S}agreements?|legal{S}hold|attorneys?|cease{S}and{S}desist"),
    ),
    Rule("marked-confidential", "Legal", LOW, words(rf"confidential|proprietary|internal{S}only|do{S}not{S}(?:share|distribute)")),
    # ---- data stores -------------------------------------------------------
    Rule("mailbox", "Data stores", HIGH, ext("pst", "ost", "mbox", "nsf"), files_only=True, code_ok=True),
    Rule(
        "database-backup",
        "Data stores",
        MEDIUM,
        re.compile(r"\.(?:bacpac|mdf|ldf)$|(?:backup|dump)[^\\/]*\.(?:sql|bak|zip|7z|gz)$", re.I),
        files_only=True,
        code_ok=True,
    ),
    Rule("disk-image", "Data stores", LOW, ext("vhdx?", "vmdk", "ova", "gho", "tib"), files_only=True, code_ok=True),
)

# Everything beneath a folder with one of these names is third-party or
# generated code, where `password.js` and test certificates are routine.
VENDORED_DIRS = frozenset(
    {
        "node_modules", ".git", ".svn", ".hg", "site-packages", "dist-packages",
        "__pycache__", ".venv", "bower_components", ".nuget", ".vs", ".idea",
    }
)

# Source, build output and CAD models: a name rule does not apply unless it
# says `code_ok`. A part called `W-2 pulley` or `wire transfer actuator` is a
# part, and `PasswordInput.tsx` is a screen.
CODE_EXTENSIONS = frozenset(
    """.js .jsx .ts .tsx .mjs .cjs .map .py .pyc .cs .vb .c .h .cpp .hpp .java .class .go .rs .rb
    .php .html .htm .css .scss .less .dll .exe .so .lib .obj .pdb .xaml .resx .svg .ico
    .sldprt .sldasm .slddrw .dwg .dxf .step .stp .igs .iges .x_t .x_b .stl .prt .asm .ipt .iam
    .easm .eprt .edrw .3dxml .sat""".split()
)

# A share with one of these names holds a folder per person. Each one that
# another person's account can read is worth a look, whatever it is called.
PERSONAL_ROOTS = frozenset({"users", "home", "homes", "profiles"})
PERSONAL_RULE = Rule("readable-personal-folder", "Personal folders", MEDIUM, re.compile(""))

# One cheap test that rules most names out before the rules run one by one.
PREFILTER = re.compile("|".join(f"(?:{rule.pattern.pattern})" for rule in RULES), re.I)
