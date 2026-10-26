import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

type Manifest = {
    name: string;
    displayName: string;
    publisher: string;
    activationEvents: string[];
    contributes: {
        commands: Array<{ command: string }>;
        viewsContainers: { activitybar: Array<{ id: string }> };
        views: Record<string, Array<{ id: string }>>;
        configuration: { properties: Record<string, unknown> };
    };
};

function readManifest(): Manifest {
    const candidates = [
        path.join(process.cwd(), 'package.json'),
        path.resolve(__dirname, '..', '..', 'package.json'),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    assert.ok(found, `package.json not found; tried ${candidates.join(', ')}`);
    return JSON.parse(fs.readFileSync(found!, 'utf8')) as Manifest;
}

suite('manifest identity', () => {
    const manifest = readManifest();

    test('uses the renamed extension identity', () => {
        assert.strictEqual(manifest.name, 'thenugetpackagemanager');
        assert.strictEqual(manifest.displayName, 'NuGet Package Manager for VS Code');
        assert.strictEqual(manifest.publisher, 'I-Synergy');
    });

    test('contributes only the new command IDs', () => {
        const ids = manifest.contributes.commands.map((command) => command.command);
        assert.ok(ids.length > 0);
        for (const id of ids) {
            assert.ok(id.startsWith('theNugetPackageManager.'), `unexpected command id: ${id}`);
        }
        assert.ok(ids.includes('theNugetPackageManager.open'));
    });

    test('uses the renamed view and panel IDs', () => {
        const container = manifest.contributes.viewsContainers.activitybar[0]!;
        assert.strictEqual(container.id, 'theNugetPackageManager');
        assert.deepStrictEqual(
            manifest.contributes.views['theNugetPackageManager']?.map((view) => view.id),
            ['theNugetPackageManager.launcherView']
        );
        assert.ok(
            manifest.activationEvents.includes('onWebviewPanel:theNugetPackageManager.panel'),
            'the webview panel activation event must use the new ID'
        );
    });

    test('contributes the new settings namespace without legacy keys', () => {
        const keys = Object.keys(manifest.contributes.configuration.properties);
        const newKeys = keys.filter((key) => key.startsWith('theNugetPackageManager.'));
        const legacyKeys = keys.filter((key) => key.startsWith('i-synergy-nugetpackagemanager.'));

        assert.strictEqual(newKeys.length, 12);
        assert.strictEqual(legacyKeys.length, 0);
        assert.ok(newKeys.includes('theNugetPackageManager.updateCheckConcurrency'));
    });

    test('does not register legacy activation events', () => {
        assert.ok(!manifest.activationEvents.includes('onWebviewPanel:nugetpackage.panel'));
    });
});
