# GitHub Copilot Instructions

You are assisting with a .NET project following Clean Architecture, CQRS, and DDD patterns.

## Project Context

See `.claude/project/architecture.md` for complete architecture documentation and `.claude/project/tech-stack.md` for the full technology stack.

## Critical Rules

See `.claude/reference/critical-rules.md` for complete rules with examples. Violations cause bugs.

**Key rules:**
- Commands use individual parameters (NOT model objects passed directly)
- Data access: EF Core primitives on named DbSet properties only — `FirstOrDefaultAsync`, `Add`, `Remove`, `SaveChangesAsync`
- Delete: `FirstOrDefaultAsync` + `Remove` + check `rowsAffected > 0` — no extension methods
- Update: `FirstOrDefaultAsync` + mutate properties + `SaveChangesAsync` — NO `.Update()` call (change tracker handles it)
- Mapping: Mapster only — `entity.Adapt<T>()` or `ProjectToType<T>()` — NOT AutoMapper, NOT manual mapping
- Async: always `CancellationToken` — NO `.Wait()` or `.Result`
- Return types: responses wrap models — never return domain entities directly
- Handler naming: `Create{Entity}CommandHandler` / `Get{Entity}ByIdQueryHandler` (must end in `CommandHandler` or `QueryHandler`)
- Entity construction: direct `new Entity { ... }` in handlers — NOT `command.Adapt<Entity>()`
- Enum naming: plural names (`PaymentProviders`, not `PaymentProvider`) except `*Status` enums

## Architecture

**Clean Architecture Layers:**
- Domain: `{ApplicationName}.Domain.*` — CQRS handlers, domain logic
- Application: `{ApplicationName}.Services.*` — API endpoints
- Infrastructure: `{ApplicationName}.Data.*` — EF Core persistence
- Presentation: `{ApplicationName}.UI.*` — Blazor/MAUI

**Vertical Slice Organization:**
```
{ApplicationName}.Domain.{Domain}/
  Features/{Entity}/
    Commands/Create{Entity}/
      Create{Entity}Command.cs
      Create{Entity}CommandHandler.cs
      Create{Entity}Response.cs
    Queries/Get{Entity}ById/
      ...
  Models/{Entity}.cs             (positional record, no "Model" suffix)
  Mappers/Configuration.cs       (single Mapster IRegister per domain)
  Extensions/ServiceCollectionExtensions.cs
```

## Forbidden Technologies

See `.claude/reference/forbidden-tech.md` for the complete list.

- NO MediatR — use I-Synergy.Framework.CQRS
- NO AutoMapper — use Mapster
- NO xUnit/NUnit — use MSTest
- NO FluentValidation — use DataAnnotations
- NO repository interfaces — use EF Core directly via named DbSet properties
- NO `.Update()` on tracked EF entities — change tracker handles it

## Patterns & Templates

- CQRS: `.claude/patterns/cqrs-patterns.md`
- API: `.claude/patterns/api-patterns.md`
- Testing: `.claude/patterns/testing-patterns.md`
- Templates: `.claude/reference/templates/` — `command-handler.cs.txt`, `query-handler.cs.txt`, `endpoint.cs.txt`, `mapping-config.cs.txt`

## Naming Conventions

- Commands: `{Action}{Entity}Command` — e.g. `CreateBudgetCommand`
- Queries: `Get{Entity}{Criteria}Query` — e.g. `GetBudgetByIdQuery`
- Command handlers: `{Action}{Entity}CommandHandler` — e.g. `CreateBudgetCommandHandler`
- Query handlers: `Get{Entity}{Criteria}QueryHandler` — e.g. `GetBudgetByIdQueryHandler`
- Models: no "Model" suffix — `Budget` not `BudgetModel`

## Token Replacements

See `.claude/reference/tokens.md` for complete definitions.

- `{ApplicationName}` — your application name
- `{Domain}` — domain/bounded context
- `{Entity}` — entity name (PascalCase)
