#!/bin/bash
# Validate file references in documentation

TEMPLATE_ROOT="/d/Projects/Template"
FAILED=0
PASSED=0

echo "========================================="
echo "  Reference Validation"
echo "========================================="
echo ""

# Function to check if a file reference exists
check_reference() {
    local file_ref="$1"
    local context="$2"

    # Convert relative paths to absolute
    if [[ "$file_ref" == ./* ]] || [[ "$file_ref" == ../* ]]; then
        file_ref="$TEMPLATE_ROOT/.claude/$file_ref"
    elif [[ "$file_ref" != /* ]]; then
        file_ref="$TEMPLATE_ROOT/$file_ref"
    fi

    if [ -f "$file_ref" ] || [ -d "$file_ref" ]; then
        echo "✅ $context: $file_ref"
        PASSED=$((PASSED + 1))
        return 0
    else
        echo "❌ $context: $file_ref (NOT FOUND)"
        FAILED=$((FAILED + 1))
        return 1
    fi
}

# Check references in CLAUDE.md
echo "1. Checking references in CLAUDE.md..."
if [ -f "$TEMPLATE_ROOT/CLAUDE.md" ]; then
    # Check skill references
    check_reference ".claude/skills/dotnet-engineer/SKILL.md" "CLAUDE.md skill ref"
    check_reference ".claude/skills/unit-tester/SKILL.md" "CLAUDE.md skill ref"
    check_reference ".claude/skills/architect/SKILL.md" "CLAUDE.md skill ref"

    # Check pattern references
    check_reference ".claude/patterns/cqrs-patterns.md" "CLAUDE.md pattern ref"
    check_reference ".claude/patterns/api-patterns.md" "CLAUDE.md pattern ref"
    check_reference ".claude/patterns/testing-patterns.md" "CLAUDE.md pattern ref"

    # Check reference files
    check_reference ".claude/reference/tokens.md" "CLAUDE.md reference ref"
    check_reference ".claude/reference/glossary.md" "CLAUDE.md reference ref"
    check_reference ".claude/reference/critical-rules.md" "CLAUDE.md reference ref"

    # Check project files
    check_reference ".claude/project/session-context.md" "CLAUDE.md project ref"
    check_reference ".claude/project/preferences.md" "CLAUDE.md project ref"
else
    echo "❌ CLAUDE.md not found"
    FAILED=$((FAILED + 1))
fi

echo ""

# Check template file references
echo "2. Checking template files..."
templates=(
    ".claude/reference/templates/command-handler.cs.txt"
    ".claude/reference/templates/query-handler.cs.txt"
    ".claude/reference/templates/endpoint.cs.txt"
    ".claude/reference/templates/mapping-config.cs.txt"
    ".claude/reference/templates/test-class.cs.txt"
    ".claude/reference/templates/feature-file.feature.txt"
)

for tmpl in "${templates[@]}"; do
    check_reference "$tmpl" "Template file"
done

echo ""

# Check pattern cross-references
echo "3. Checking pattern cross-references..."
if [ -f "$TEMPLATE_ROOT/.claude/patterns/cqrs-patterns.md" ]; then
    echo "✅ CQRS patterns file exists for cross-ref"
    PASSED=$((PASSED + 1))
else
    echo "❌ CQRS patterns file missing"
    FAILED=$((FAILED + 1))
fi

if [ -f "$TEMPLATE_ROOT/.claude/patterns/testing-patterns.md" ]; then
    echo "✅ Testing patterns file exists for cross-ref"
    PASSED=$((PASSED + 1))
else
    echo "❌ Testing patterns file missing"
    FAILED=$((FAILED + 1))
fi

echo ""

# Check for broken markdown links in key files
echo "4. Checking for common broken links..."
key_files=(
    "$TEMPLATE_ROOT/CLAUDE.md"
    "$TEMPLATE_ROOT/README.md"
    "$TEMPLATE_ROOT/.claude/reference/tokens.md"
    "$TEMPLATE_ROOT/.claude/reference/glossary.md"
)

for file in "${key_files[@]}"; do
    if [ -f "$file" ]; then
        # Extract markdown links [text](path)
        links=$(grep -oE '\[.*\]\([^)]+\)' "$file" 2>/dev/null | grep -oE '\([^)]+\)' | tr -d '()' || true)

        if [ -n "$links" ]; then
            while IFS= read -r link; do
                # Skip URLs (http/https)
                if [[ "$link" == http* ]]; then
                    continue
                fi

                # Skip anchors
                if [[ "$link" == \#* ]]; then
                    continue
                fi

                # Check if referenced file exists
                link_path="$TEMPLATE_ROOT/$link"
                if [ -f "$link_path" ]; then
                    echo "✅ Link in $(basename $file): $link"
                    PASSED=$((PASSED + 1))
                else
                    # Try relative to file location
                    file_dir=$(dirname "$file")
                    link_path="$file_dir/$link"
                    if [ -f "$link_path" ]; then
                        echo "✅ Link in $(basename $file): $link (relative)"
                        PASSED=$((PASSED + 1))
                    else
                        echo "❌ Broken link in $(basename $file): $link"
                        FAILED=$((FAILED + 1))
                    fi
                fi
            done <<< "$links"
        fi
    fi
done

echo ""

# Check skill directory consistency
echo "5. Checking skill directory consistency..."
for skill_dir in "$TEMPLATE_ROOT/.claude/skills"/*; do
    if [ -d "$skill_dir" ]; then
        skill_name=$(basename "$skill_dir")

        # Skip non-skill directories
        if [ "$skill_name" == "README.md" ] || [[ "$skill_name" == *.md ]]; then
            continue
        fi

        if [ -f "$skill_dir/SKILL.md" ]; then
            echo "✅ Skill $skill_name has SKILL.md"
            PASSED=$((PASSED + 1))
        else
            echo "❌ Skill $skill_name missing SKILL.md"
            FAILED=$((FAILED + 1))
        fi
    fi
done

echo ""
echo "========================================="
echo "Reference Validation Summary"
echo "========================================="
echo "✅ Passed: $PASSED"
echo "❌ Failed: $FAILED"
echo "========================================="

if [ $FAILED -eq 0 ]; then
    echo "✅ ALL REFERENCE TESTS PASSED"
    exit 0
else
    echo "❌ SOME REFERENCE TESTS FAILED"
    exit 1
fi
