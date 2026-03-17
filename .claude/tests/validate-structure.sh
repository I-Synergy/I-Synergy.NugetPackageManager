#!/bin/bash
# Validate directory structure of Claude template

TEMPLATE_ROOT="/d/Projects/Template"
FAILED=0
PASSED=0

echo "========================================="
echo "  Template Structure Validation"
echo "========================================="
echo ""

# Check required directories
echo "1. Checking required directories..."
required_dirs=(
    ".claude/skills"
    ".claude/patterns"
    ".claude/reference"
    ".claude/reference/templates"
    ".claude/checklists"
    ".claude/project"
    ".claude/tests"
)

for dir in "${required_dirs[@]}"; do
    if [ ! -d "$TEMPLATE_ROOT/$dir" ]; then
        echo "❌ Missing directory: $dir"
        FAILED=$((FAILED + 1))
    else
        echo "✅ Directory exists: $dir"
        PASSED=$((PASSED + 1))
    fi
done

echo ""

# Check all skills have SKILL.md
echo "2. Checking skill SKILL.md files..."
skills=(
    "dotnet-engineer"
    "unit-tester"
    "playwright-tester"
    "code-reviewer"
    "technical-writer"
    "architect"
    "database-migration"
    "api-security"
    "performance-engineer"
    "devops-engineer"
    "integration-specialist"
    "blazor-specialist"
    "maui-specialist"
    "software-security"
    "security"
)

for skill in "${skills[@]}"; do
    if [ ! -f "$TEMPLATE_ROOT/.claude/skills/$skill/SKILL.md" ]; then
        echo "❌ Missing SKILL.md for: $skill"
        FAILED=$((FAILED + 1))
    else
        echo "✅ Skill exists: $skill"
        PASSED=$((PASSED + 1))
    fi
done

echo ""

# Check pattern files
echo "3. Checking pattern files..."
patterns=(
    "cqrs-patterns.md"
    "api-patterns.md"
    "testing-patterns.md"
    "mvvm.md"
    "microservices.md"
    "service-oriented-architecture.md"
    "object-oriented-programming.md"
    "test-driven-development.md"
)

for pattern in "${patterns[@]}"; do
    if [ ! -f "$TEMPLATE_ROOT/.claude/patterns/$pattern" ]; then
        echo "❌ Missing pattern: $pattern"
        FAILED=$((FAILED + 1))
    else
        echo "✅ Pattern exists: $pattern"
        PASSED=$((PASSED + 1))
    fi
done

echo ""

# Check reference files
echo "4. Checking reference files..."
reference_files=(
    "critical-rules.md"
    "forbidden-tech.md"
    "glossary.md"
    "naming-conventions.md"
    "tokens.md"
)

for ref in "${reference_files[@]}"; do
    if [ ! -f "$TEMPLATE_ROOT/.claude/reference/$ref" ]; then
        echo "❌ Missing reference: $ref"
        FAILED=$((FAILED + 1))
    else
        echo "✅ Reference exists: $ref"
        PASSED=$((PASSED + 1))
    fi
done

echo ""

# Check project files
echo "5. Checking project files..."
project_files=(
    "architecture.md"
    "domains.md"
    "preferences.md"
    "session-context.md"
    "tech-stack.md"
)

for proj in "${project_files[@]}"; do
    if [ ! -f "$TEMPLATE_ROOT/.claude/project/$proj" ]; then
        echo "❌ Missing project file: $proj"
        FAILED=$((FAILED + 1))
    else
        echo "✅ Project file exists: $proj"
        PASSED=$((PASSED + 1))
    fi
done

echo ""

# Check checklist files
echo "6. Checking checklist files..."
if [ ! -f "$TEMPLATE_ROOT/.claude/checklists/pre-submission.md" ]; then
    echo "❌ Missing pre-submission checklist"
    FAILED=$((FAILED + 1))
else
    echo "✅ Pre-submission checklist exists"
    PASSED=$((PASSED + 1))
fi

echo ""

# Check template files
echo "7. Checking template files..."
template_files=(
    "command-handler.cs.txt"
    "query-handler.cs.txt"
    "endpoint.cs.txt"
    "mapping-config.cs.txt"
    "test-class.cs.txt"
    "feature-file.feature.txt"
)

for tmpl in "${template_files[@]}"; do
    if [ ! -f "$TEMPLATE_ROOT/.claude/reference/templates/$tmpl" ]; then
        echo "❌ Missing template: $tmpl"
        FAILED=$((FAILED + 1))
    else
        echo "✅ Template exists: $tmpl"
        PASSED=$((PASSED + 1))
    fi
done

echo ""

# Check main documentation files
echo "8. Checking main documentation files..."
main_files=(
    "CLAUDE.md"
    "README.md"
)

for main in "${main_files[@]}"; do
    if [ ! -f "$TEMPLATE_ROOT/$main" ]; then
        echo "❌ Missing main file: $main"
        FAILED=$((FAILED + 1))
    else
        echo "✅ Main file exists: $main"
        PASSED=$((PASSED + 1))
    fi
done

echo ""
echo "========================================="
echo "Structure Validation Summary"
echo "========================================="
echo "✅ Passed: $PASSED"
echo "❌ Failed: $FAILED"
echo "========================================="

if [ $FAILED -eq 0 ]; then
    echo "✅ ALL STRUCTURE TESTS PASSED"
    exit 0
else
    echo "❌ SOME STRUCTURE TESTS FAILED"
    exit 1
fi
