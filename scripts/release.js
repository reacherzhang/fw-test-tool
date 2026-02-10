/**
 * release.js
 * 
 * Automates the release process for IoT Nexus Core:
 * 1. Checks current version
 * 2. Increments patch version (1.0.0 -> 1.0.1)
 * 3. Updates package.json
 * 4. Pushes new tag to remote to trigger GitHub Actions
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');

// Helper to run shell commands
const run = (cmd) => {
    console.log(`> ${cmd}`);
    try {
        return execSync(cmd, { cwd: rootDir, stdio: 'pipe' }).toString().trim();
    } catch (error) {
        console.error(`Error executing: ${cmd}`);
        console.error(error.message);
        process.exit(1);
    }
};

async function main() {
    console.log('🚀 Starting Automated Release Process...');

    // 1. Ensure git is clean
    const status = run('git status --porcelain');
    if (status) {
        console.error('❌ Git working directory is not clean. Commit changes first.');
        process.exit(1);
    }

    // 2. Read current version
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const currentVersion = pkg.version;
    console.log(`Current version: ${currentVersion}`);

    // 3. Using npm version to bump
    // This updates package.json and creates a git commit + tag
    console.log('📦 Bumping patch version...');
    try {
        // Check if tag exists remotely first? GitHub Action handles this usually
        // Just force npm version patch
        const newVersion = run('npm version patch -m "chore(release): %s"');
        // newVersion will be v1.0.1
        console.log(`✅ Bumped to: ${newVersion}`);

        // 4. Push to remote
        console.log('📤 Pushing to remote...');
        run('git push origin main');
        run(`git push origin ${newVersion}`);

        console.log(`🎉 Released ${newVersion}! GitHub Actions should now start building.`);
        console.log(`🔗 Check progress: https://github.com/reacherzhang/fw-test-tool/actions`);
    } catch (e) {
        console.error('Failed to bump version:', e.message);
        process.exit(1);
    }
}

main();
