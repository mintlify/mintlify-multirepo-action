import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import { writeFile, readFile } from 'fs/promises';
import { parse } from 'yaml';
import path from 'path';
const execOrThrow = async (...args) => {
    const exitCode = await exec.exec(...args);
    if (exitCode !== 0)
        throw Error(`error running command: ${args[0]} ${args[1]?.join(' ') ?? ''}`);
};
const setToken = async (token) => {
    const encodedToken = Buffer.from(`x-access-token:${token}`, 'utf-8').toString('base64');
    core.setSecret(encodedToken);
    const headerPlaceholder = 'Authorization: basic ***';
    const headerValue = `Authorization: basic ${encodedToken}`;
    const headerKey = 'http.https://github.com/.extraheader';
    const configPath = '.git/config';
    await execOrThrow('git', ['config', '--local', headerKey, headerPlaceholder]);
    const configString = await readFile(configPath, 'utf-8');
    await writeFile(configPath, configString.replace(headerPlaceholder, headerValue));
    return () => execOrThrow('git', ['config', '--local', '--unset-all', headerKey]);
};
const prependPrefix = (group, prefix) => {
    return {
        ...group,
        pages: group.pages.map((entry) => (typeof entry === 'string'
            ? `${prefix}/${entry}`
            : prependPrefix(entry, prefix))),
    };
};
const mergeNavigation = (main, sub, prefix) => {
    return [...main, ...sub.map((group) => prependPrefix(group, prefix))];
};
const checkoutBranch = async (branch) => {
    try {
        await execOrThrow('git', ['ls-remote', '--heads', '--exit-code', 'origin', branch]);
        await execOrThrow('git', ['fetch', '-u', 'origin', `${branch}:${branch}`]);
        await execOrThrow('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    }
    catch {
        await execOrThrow('git', ['checkout', '-b', branch]);
    }
};
let resetToken;
try {
    const token = core.getInput('token');
    const repos = parse(core.getInput('repos'));
    const targetBranch = core.getInput('target-branch');
    const subdirectory = core.getInput('subdirectory');
    const force = core.getBooleanInput('force');
    process.chdir(subdirectory);
    await checkoutBranch(targetBranch);
    const mainConfig = JSON.parse(await readFile('mint.json', 'utf-8'));
    resetToken = await setToken(token);
    for (const { owner, repo, ref, subdirectory: subrepoSubdirectory } of repos) {
        await io.rmRF(repo);
        const args = ['clone', '--depth=1'];
        if (ref)
            args.push('--branch', ref);
        args.push(`https://${token}@github.com/${owner}/${repo}.git`);
        await execOrThrow('git', args);
        if (subrepoSubdirectory) {
            const tempDirName = 'temporary-docs-dir';
            await io.mv(path.join(repo, subrepoSubdirectory), tempDirName);
            await io.rmRF(repo);
            await io.mv(tempDirName, repo);
        }
        else {
            await io.rmRF(`${repo}/.git`);
        }
        const subConfig = JSON.parse(await readFile(path.join(repo, 'mint.json'), 'utf-8'));
        mainConfig.navigation = mergeNavigation(mainConfig.navigation, subConfig.navigation, repo);
    }
    await writeFile('mint.json', JSON.stringify(mainConfig, null, 2));
    await execOrThrow('git', ['add', '.']);
    try {
        await exec.exec('git', ['diff-index', '--quiet', '--cached', 'HEAD', '--']) !== 0;
        console.log('No changes detected, skipping...');
    }
    catch {
        await execOrThrow('git', ['config', 'user.name', 'Mintie Bot']);
        await execOrThrow('git', ['config', 'user.email', 'aws@mintlify.com']);
        await execOrThrow('git', ['commit', '-m', 'update']);
        const pushArgs = ['push'];
        if (force)
            pushArgs.push('--force');
        pushArgs.push('origin', targetBranch);
        await execOrThrow('git', pushArgs);
    }
}
catch (error) {
    const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : JSON.stringify(error, null, 2);
    core.setFailed(message);
}
finally {
    resetToken?.();
}
