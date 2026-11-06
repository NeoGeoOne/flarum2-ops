#!/usr/bin/env python3
"""Validate every skill in skills/ against the Agent Skills specification.

Checks, per folder in skills/:
- frontmatter (https://agentskills.io/specification): `name` format and length, equal to the folder;
  `description` 1-1024 and `compatibility` 1-500 characters; values that YAML would reject or misread;
- SKILL.md at most 500 lines;
- every `references/…`, `scripts/…` or `assets/…` path named in SKILL.md or a reference file exists;
- bundled Python scripts parse with Python 3.9 grammar (best effort; CI also runs them on Python 3.9).
If PyYAML is installed (CI installs it), the frontmatter is also loaded with it and compared.
Standard library only otherwise; runs on Python 3.9+. Exit code 1 on any problem.
"""
import ast
import pathlib
import re
import sys

try:
    import yaml  # optional cross-check
except ImportError:
    yaml = None

ROOT = pathlib.Path(__file__).resolve().parent.parent / "skills"
NOT_SKILLS = set()
MIN_PYTHON = (3, 9)
MAX_LINES = 500
NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
REF_RE = re.compile(r"(?:(?<=\./)|(?<![\w/.-]))((?:references|scripts|assets)/[\w./-]+\.\w+)")
KEY_RE = re.compile(r"^([A-Za-z][\w-]*):(?:[ \t]+(.*))?$")
BLOCK_RE = re.compile(r"^[>|](?:[+-]?[1-9]?|[1-9][+-])$")
CHECKED = ("name", "description", "compatibility")


def scalar(raw, key):
    """Return (value, problem) for a one-line YAML scalar, flagging what YAML would reject or misread."""
    v = raw.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        return v[1:-1], None
    if v[:1] in ("'", '"'):
        return v, f"{key}: unclosed quote"
    if v[:1] in tuple("[]{}&*!%@`,#"):
        return v, f"{key}: a plain value must not start with {v[0]!r}; put it in quotes"
    if ": " in v or v.endswith(":"):
        return v, f"{key}: ': ' in a plain value breaks YAML; put it in quotes or use a '>-' block"
    if " #" in v:
        return v, f"{key}: ' #' starts a YAML comment and cuts the value; put it in quotes"
    return v, None


def frontmatter(text):
    """Return (fields, problems, frontmatter text, body) for the simple frontmatter subset skills use."""
    if not text.startswith("---\n"):
        raise ValueError("SKILL.md must start with a '---' line")
    end = re.search(r"^---[ \t]*$", text[4:], re.M)
    if not end:
        raise ValueError("frontmatter is not closed with a '---' line")
    fm, body = text[4:4 + end.start()], text[4 + end.end():]
    fields, problems, key, block = {}, [], None, False
    for line in fm.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = KEY_RE.match(line)
        if m:
            key, value = m.group(1), (m.group(2) or "").strip()
            block = bool(BLOCK_RE.match(value))
            if block or not value:
                fields[key] = ""
            else:
                fields[key], problem = scalar(value, key)
                if problem and key in CHECKED:
                    problems.append(problem)
        elif key and line[:1] in (" ", "\t"):
            part = line.strip()
            if not block and key in CHECKED and (": " in part or " #" in part):
                problems.append(f"{key}: ': ' or ' #' on a continuation line breaks YAML; use a '>-' block")
            fields[key] = (fields[key] + " " + part).strip()
        else:
            problems.append(f"unexpected frontmatter line: {line[:40]!r}")
    return fields, problems, fm, body


def yaml_problems(fm, fields):
    if yaml is None:
        return []
    try:
        data = yaml.safe_load(fm)
    except yaml.YAMLError as e:
        return [f"frontmatter is not valid YAML: {str(e).splitlines()[0]}"]
    if not isinstance(data, dict):
        return ["frontmatter is not a YAML mapping"]
    out = []
    for k in CHECKED:
        if k in data or k in fields:
            theirs = " ".join(str(data.get(k, "")).split())
            ours = " ".join(fields.get(k, "").split())
            if theirs != ours:
                out.append(f"{k}: YAML reads {theirs[:50]!r}, the validator reads {ours[:50]!r}")
    return out


def read(path, problems):
    try:
        return path.read_text(encoding="utf-8").lstrip("﻿").replace("\r\n", "\n")
    except UnicodeDecodeError:
        problems.append(f"{path.name} is not valid UTF-8")
    except OSError as e:
        problems.append(f"{path.name}: {e}")
    return None


def check(skill):
    problems = []
    text = read(skill / "SKILL.md", problems)
    if text is None:
        return problems
    try:
        fields, fm_problems, fm, body = frontmatter(text)
    except ValueError as e:
        return [str(e)]
    problems += fm_problems + yaml_problems(fm, fields)
    name, desc = fields.get("name", ""), fields.get("description", "")
    if not NAME_RE.match(name) or len(name) > 64:
        problems.append(f"invalid name {name!r} (lowercase letters, digits, single hyphens, max 64)")
    if name != skill.name:
        problems.append(f"name {name!r} does not match folder {skill.name!r}")
    if not 1 <= len(desc) <= 1024:
        problems.append(f"description has {len(desc)} characters (1-1024 allowed)")
    if "compatibility" in fields and not 1 <= len(fields["compatibility"]) <= 500:
        problems.append("compatibility must have 1-500 characters")
    lines = text.count("\n") + (0 if text.endswith("\n") else 1)
    if lines > MAX_LINES:
        problems.append(f"SKILL.md has {lines} lines (max {MAX_LINES}); move detail into references/")
    sources = [("SKILL.md", body)]
    for ref_file in sorted(skill.glob("references/*.md")):
        ref_text = read(ref_file, problems)
        if ref_text is not None:
            sources.append((f"references/{ref_file.name}", ref_text))
    for where, content in sources:
        for ref in sorted(set(REF_RE.findall(content))):
            if not (skill / ref).exists():
                problems.append(f"referenced file missing: {ref} (named in {where})")
    for script in sorted(skill.glob("scripts/*.py")):
        source = read(script, problems)
        if source is None:
            continue
        try:
            ast.parse(source, str(script), feature_version=MIN_PYTHON)
        except (SyntaxError, ValueError) as e:
            line = getattr(e, "lineno", None)
            problems.append(f"{script.name} is not valid Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}: line {line}: {e}")
    return problems


def main():
    folders = sorted(p for p in ROOT.iterdir() if p.is_dir() and not p.name.startswith(".") and p.name not in NOT_SKILLS)
    if not folders:
        print("no skills found")
        return 1
    failed = 0
    for folder in folders:
        problems = check(folder) if (folder / "SKILL.md").is_file() else ["folder has no SKILL.md"]
        print(f"{'FAIL' if problems else 'ok  '} {folder.name}")
        for p in problems:
            print(f"     - {p}")
        failed += bool(problems)
    if yaml is None:
        print("note: PyYAML not installed, YAML cross-check skipped")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
