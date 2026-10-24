import * as vscode from "vscode";

let badgeView: vscode.TreeView<unknown> | undefined;

export function RegisterBadgeView(view: vscode.TreeView<unknown>): void {
  badgeView = view;
}

export function ClearBadgeView(view: vscode.TreeView<unknown>): void {
  if (badgeView === view) badgeView = undefined;
}

export function SetUpdateBadge(count: number): void {
  if (!badgeView) return;
  const value = Math.max(0, Math.floor(count));
  badgeView.badge = value > 0
    ? { value, tooltip: `${value} update${value === 1 ? "" : "s"} available` }
    : undefined;
}
