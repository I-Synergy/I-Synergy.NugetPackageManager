# Claude Template Testing - Quick Reference

## One Command Test

```bash
.claude/tests/run-all-tests.sh
```

## Individual Tests

```bash
# Structure
bash .claude/tests/validate-structure.sh

# YAML
python3 .claude/tests/validate-skills.py

# References
bash .claude/tests/validate-references.sh

# Content
python3 .claude/tests/validate-content.py

# Tokens
bash .claude/tests/validate-tokens.sh

# Smoke Tests
python3 .claude/tests/smoke-test.py
```

## Expected Results

```
✅✅✅ ALL TESTS PASSED ✅✅✅

Total test suites: 6
Passed: 6
Failed: 0
```

## Test Coverage

| Test | What It Checks | Count |
|------|---------------|-------|
| **Structure** | Directories + files exist | 49 |
| **YAML** | Skill frontmatter valid | 15 |
| **References** | File refs + links valid | 34 |
| **Content** | Quality + examples | 23 |
| **Tokens** | Token consistency | 19 |
| **Smoke** | Integration tests | 7 |
| **TOTAL** | | **147** |

## Quick Fixes

### Permission Denied
```bash
chmod +x .claude/tests/*.sh .claude/tests/*.py
```

### PyYAML Missing
```bash
pip install pyyaml
```

### Test Fails

1. Read error message
2. Fix the issue
3. Re-run specific test
4. Run full suite to verify

## Files Validated

- ✅ 15 skills
- ✅ 8 patterns
- ✅ 6 templates
- ✅ 5 reference docs
- ✅ 5 project files
- ✅ 2 main docs (CLAUDE.md, README.md)

**Total: 41 files + 7 directories**

## Success Criteria

All checks must pass:
- [x] Directory structure complete
- [x] All skill YAML valid
- [x] All file references exist
- [x] Content has examples
- [x] Tokens properly defined
- [x] Skills are loadable
- [x] No duplicate names

## Runtime

~8-10 seconds for full suite

## CI/CD

Runs automatically on:
- Push to main/master/develop
- Pull requests
- Manual trigger

## Exit Codes

- `0` = Pass
- `1` = Fail

## Documentation

- **Full Guide:** `.claude/tests/TESTING-GUIDE.md`
- **Detailed README:** `.claude/tests/README.md`
- **This Card:** `.claude/tests/QUICK-REFERENCE.md`
