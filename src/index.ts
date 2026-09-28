import * as core from '@actions/core'
import * as io from '@actions/io'
import {spawnSync} from 'child_process'
import * as utils from './utils'
import * as github from '@actions/github'
import {Inputs, createPullRequest} from './github-helper'
import {PullRequest} from '@octokit/webhooks-definitions/schema'

// git's wording when the pick applied cleanly but produced no change. Prefix match on purpose: the
// trailing "possibly due to conflict resolution." differs between git versions.
const CHERRYPICK_EMPTY = 'The previous cherry-pick is now empty'

// Matches any git cherry-pick conflict marker, e.g.:
//   CONFLICT (content): Merge conflict in ...
//   CONFLICT (modify/delete): ... deleted in HEAD and modified in ...
//   CONFLICT (rename/delete): ...
//   CONFLICT (add/add): ...
const CHERRYPICK_CONFLICT = /^CONFLICT \(/m

// What the run ended up doing. `created` and `created-with-conflicts` mean a PR exists (see the
// `number` output); `already-present` means the change was already on the target branch and no PR
// was opened. Callers that gate follow-up steps on `number != ''` keep working unchanged.
export type Outcome = 'created' | 'created-with-conflicts' | 'already-present'

export async function run(): Promise<void> {
  try {
    const inputs: Inputs = {
      token: core.getInput('token'),
      committer: core.getInput('committer'),
      author: core.getInput('author'),
      branch: core.getInput('branch'),
      title: core.getInput('title'),
      body: core.getInput('body'),
      force: utils.getInputAsBoolean('force'),
      labels: utils.getInputAsArray('labels'),
      inherit_labels: utils.getInputAsBoolean('inherit_labels'),
      assignees: utils.getInputAsArray('assignees'),
      reviewers: utils.getInputAsArray('reviewers'),
      teamReviewers: utils.getInputAsArray('teamReviewers'),
      cherryPickBranch: core.getInput('cherry-pick-branch')
    }

    core.info(`Cherry pick into branch ${inputs.branch}!`)

    // the value of merge_commit_sha changes depending on the status of the pull request
    // see https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request
    const githubSha = (github.context.payload.pull_request as PullRequest)
      .merge_commit_sha
    const prBranch = inputs.cherryPickBranch
      ? inputs.cherryPickBranch
      : `cherry-pick-${inputs.branch}-${githubSha}`

    // Configure the committer and author
    core.startGroup('Configuring the committer and author')
    const parsedAuthor = utils.parseDisplayNameEmail(inputs.author)
    const parsedCommitter = utils.parseDisplayNameEmail(inputs.committer)
    core.info(
      `Configured git committer as '${parsedCommitter.name} <${parsedCommitter.email}>'`
    )
    await gitExecution(['config', '--global', 'user.name', parsedAuthor.name])
    await gitExecution([
      'config',
      '--global',
      'user.email',
      parsedCommitter.email
    ])
    core.endGroup()

    // Update  branchs
    core.startGroup('Fetch all branchs')
    await gitExecution(['remote', 'update'])
    await gitExecution(['fetch', '--all'])
    core.endGroup()

    // Create branch new branch
    core.startGroup(`Create new branch ${prBranch} from ${inputs.branch}`)
    await gitExecution(['checkout', '-b', prBranch, `origin/${inputs.branch}`])
    core.endGroup()

    // Cherry pick
    core.startGroup('Cherry picking')

    const result = await gitExecution([
      'cherry-pick',
      '-X',
      'no-renames',
      '-m',
      '1',
      '--strategy=recursive',
      `${githubSha}`
    ])

    core.info(`Cherry pick finished with exit code ${result.exitCode}`)
    core.info(`Cherry pick stdout: ${result.stdout}`)
    core.info(`Cherry pick stderr: ${result.stderr}`)

    let outcome: Outcome = 'created'
    if (
      result.exitCode !== 0 &&
      (CHERRYPICK_CONFLICT.test(result.stderr) ||
        CHERRYPICK_CONFLICT.test(result.stdout))
    ) {
      await gitExecution(['add', '-A'])
      await gitExecution(['commit', '-m', 'Cherry picking with conflicts'])
      outcome = 'created-with-conflicts'
    } else if (result.exitCode !== 0) {
      if (!result.stderr.includes(CHERRYPICK_EMPTY)) {
        throw new Error(`Unexpected error: ${result.stderr}`)
      }
      // The pick applied but changed nothing: the change is already on the target (a hand-made
      // backport, a label round trip, a rebased duplicate). Pushing the branch anyway left it
      // identical to the target and the PR API answered 422 "No commits between ..." - a red job
      // and a failure alert for a change that is exactly where it should be. Leave the sequencer
      // clean and stop here instead.
      await gitExecution(['cherry-pick', '--skip'])
      core.info(
        `Nothing to cherry-pick: ${githubSha} is already on ${inputs.branch}. No PR opened.`
      )
      core.setOutput('outcome', 'already-present')
      core.setOutput('does_pr_have_conflicts', 'false')
      core.endGroup()
      return
    }
    core.setOutput(
      'does_pr_have_conflicts',
      String(outcome === 'created-with-conflicts')
    )

    core.endGroup()

    // Push new branch
    core.startGroup('Push new branch to remote')
    if (inputs.force) {
      await gitExecution(['push', '-u', 'origin', `${prBranch}`, '--force'])
    } else {
      await gitExecution(['push', '-u', 'origin', `${prBranch}`])
    }
    core.endGroup()

    // Create pull request
    core.startGroup('Opening pull request')
    const pull = await createPullRequest(inputs, prBranch)
    core.setOutput('data', JSON.stringify(pull.data))
    core.setOutput('number', pull.data.number)
    core.setOutput('html_url', pull.data.html_url)
    core.setOutput('outcome', outcome)
    core.endGroup()
  } catch (err: unknown) {
    if (err instanceof Error) {
      core.setFailed(err)
    }
  }
}

async function gitExecution(params: string[]): Promise<GitOutput> {
  const gitPath = await io.which('git', true)
  const {stdout, stderr, status} = spawnSync(gitPath, params)

  return {
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    exitCode: status ?? 0
  }
}

class GitOutput {
  stdout = ''
  stderr = ''
  exitCode = 0
}

// do not run if imported as module
if (require.main === module) {
  run()
}
