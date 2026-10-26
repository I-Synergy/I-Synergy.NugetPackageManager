import * as vscode from "vscode";
import { getSetting } from "../../common/configuration";

export default class StatusBarUtils {
  private static _item: vscode.StatusBarItem;

  public static show(percentage: number, message?: string) {
    if (!getSetting<boolean>("statusBarLoadingIndicator", false)) {
      return;
    }

    if (!this._item) {
      this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    }

    this._item.text = `$(sync~spin) NuGet: ${Math.round(percentage)}%${message ? ` - ${message}` : ""}`;
    this._item.show();
  }

  public static ShowText(message: string) {
    if (!getSetting<boolean>("statusBarLoadingIndicator", false)) {
      return;
    }

    if (!this._item) {
      this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    }

    this._item.text = `$(sync~spin) NuGet: ${message}`;
    this._item.show();
  }

  public static hide() {
    if (this._item) {
      this._item.hide();
    }
  }
}
