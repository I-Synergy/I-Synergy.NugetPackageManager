📦 NuGet Package Manager for VS Code — manage .NET packages in the editor

The problem .NET package work in VS Code means hand-editing <PackageReference> XML or dropping to the dotnet CLI, and it fails in predictable ways:

• No view across the solution — versions live in many .csproj files and Directory.Packages.props; finding drift is manual. 
• Version drift — the same package ends up on different versions across projects and framework lines, and nothing points it out. 
• Invisible risk — outdated and vulnerable packages, including transitive ones, are only discovered when you go looking. 
• Risky updates — a batch of bumps can fail halfway with no rollback, and NU1107 conflict chains are cryptic. 
• CPM and multi-targeting — conditional PackageVersion groups per TFM are easy to update on the wrong line, and unused entries pile up.

The solution One full-page NuGet workspace in an editor tab — Browse, Installed, Updates, Consolidate, Vulnerabilities and Cleanup — scoped by a checkbox project tree.

• Browse, install, update and remove packages across every selected project at once. 
• Transactional updates: versions are written one at a time, dotnet restore runs once, and a failed write or restore rolls back. 
• Dependency-aware suggestions are capped to compatible ranges, with conflicts naming the packages and ranges that block an update. 
• Vulnerability scan with CRITICAL / HIGH / MEDIUM / LOW, transitive packages, advisory links and a banner on every tab. 
• Consolidate per framework line, clean unused CPM entries with backups, and a 15-minute update badge in the Activity Bar. 
• Private feeds via NuGet.config, Azure Artifacts Credential Provider, local folder feeds and password scripts.

Marketplace: https://marketplace.visualstudio.com/items?itemName=I-Synergy.nugetpackagemanager
Source: https://github.com/I-Synergy/NugetPackageManager 
