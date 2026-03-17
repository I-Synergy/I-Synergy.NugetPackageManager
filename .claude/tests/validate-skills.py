#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate YAML frontmatter in all SKILL.md files."""

import yaml
import sys
import os
from pathlib import Path
from typing import Tuple, List

# Set UTF-8 encoding for Windows console
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# Determine template root (script location is .claude/tests/)
SCRIPT_DIR = Path(__file__).parent
TEMPLATE_ROOT = SCRIPT_DIR.parent.parent
SKILLS_DIR = TEMPLATE_ROOT / ".claude/skills"

def validate_skill(skill_path: Path) -> Tuple[bool, List[str]]:
    """Validate a single skill file.

    Args:
        skill_path: Path to the SKILL.md file

    Returns:
        Tuple of (is_valid, list_of_errors)
    """
    errors = []

    if not skill_path.exists():
        return False, [f"File does not exist: {skill_path}"]

    try:
        content = skill_path.read_text(encoding='utf-8')
    except Exception as e:
        return False, [f"Failed to read file: {e}"]

    # Check for YAML frontmatter
    if not content.startswith('---'):
        errors.append("Missing YAML frontmatter (must start with '---')")
        return False, errors

    # Extract frontmatter
    parts = content.split('---', 2)
    if len(parts) < 3:
        errors.append("Invalid YAML frontmatter format (missing closing '---')")
        return False, errors

    # Parse YAML
    try:
        frontmatter = yaml.safe_load(parts[1])
    except yaml.YAMLError as e:
        errors.append(f"YAML parse error: {e}")
        return False, errors

    if frontmatter is None:
        errors.append("Empty YAML frontmatter")
        return False, errors

    # Check required fields
    if 'name' not in frontmatter:
        errors.append("Missing required field: 'name'")
    elif not isinstance(frontmatter['name'], str):
        errors.append("Field 'name' must be a string")
    elif len(frontmatter['name'].strip()) == 0:
        errors.append("Field 'name' cannot be empty")

    if 'description' not in frontmatter:
        errors.append("Missing required field: 'description'")
    elif not isinstance(frontmatter['description'], str):
        errors.append("Field 'description' must be a string")
    elif len(frontmatter['description'].strip()) < 10:
        errors.append(f"Field 'description' too short ({len(frontmatter['description'])} chars, minimum 10)")

    # Check name matches directory
    expected_name = skill_path.parent.name
    if 'name' in frontmatter:
        actual_name = frontmatter['name']
        if isinstance(actual_name, str) and actual_name != expected_name:
            errors.append(f"Name mismatch: frontmatter has '{actual_name}' but directory is '{expected_name}'")

    # Validate boolean fields if present
    for bool_field in ['disable-model-invocation', 'user-invocable']:
        if bool_field in frontmatter:
            if not isinstance(frontmatter[bool_field], bool):
                errors.append(f"Field '{bool_field}' must be boolean (true/false), got {type(frontmatter[bool_field]).__name__}")

    # Validate allowed-tools format if present
    if 'allowed-tools' in frontmatter:
        allowed_tools = frontmatter['allowed-tools']
        if not isinstance(allowed_tools, list):
            errors.append(f"Field 'allowed-tools' must be a list, got {type(allowed_tools).__name__}")
        else:
            for i, tool in enumerate(allowed_tools):
                if not isinstance(tool, str):
                    errors.append(f"allowed-tools[{i}] must be a string, got {type(tool).__name__}")

    # Check content length
    content_body = parts[2].strip()
    if len(content_body) < 100:
        errors.append(f"Skill content too short ({len(content_body)} chars, expected >100 chars)")

    return len(errors) == 0, errors

def main():
    """Validate all skills."""
    print("=========================================")
    print("  YAML Frontmatter Validation")
    print("=========================================")
    print()

    all_valid = True
    skills_found = 0
    total_errors = 0

    # Get all skill directories
    if not SKILLS_DIR.exists():
        print(f"❌ Skills directory not found: {SKILLS_DIR}")
        return 1

    skill_dirs = sorted([d for d in SKILLS_DIR.iterdir() if d.is_dir()])

    if not skill_dirs:
        print(f"❌ No skill directories found in {SKILLS_DIR}")
        return 1

    for skill_dir in skill_dirs:
        skill_file = skill_dir / "SKILL.md"
        skills_found += 1

        valid, errors = validate_skill(skill_file)

        if valid:
            print(f"✅ {skill_dir.name}")
        else:
            print(f"❌ {skill_dir.name}")
            for error in errors:
                print(f"   - {error}")
            all_valid = False
            total_errors += len(errors)

    print()
    print("=========================================")
    print("YAML Validation Summary")
    print("=========================================")
    print(f"Skills validated: {skills_found}")
    print(f"Errors found: {total_errors}")
    print("=========================================")

    if all_valid:
        print("✅ ALL YAML TESTS PASSED")
        return 0
    else:
        print("❌ SOME YAML TESTS FAILED")
        return 1

if __name__ == '__main__':
    sys.exit(main())
