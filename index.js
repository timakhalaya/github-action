// @ts-check
const { restoreCache, saveCache } = require('@actions/cache')
const core = require('@actions/core')
const exec = require('@actions/exec')
const io = require('@actions/io')
const { Octokit } = require('@octokit/core')
const hasha = require('hasha')
const got = require('got')
const fs = require('fs')
const os = require('os')
const path = require('path')
const quote = require('quote')
const cliParser = require('argument-vector')()
const findYarnWorkspaceRoot = require('find-yarn-workspace-root')

/**
 * A small utility for checking when an URL responds, kind of
 * a poor man's https://www.npmjs.com/package/wait-on
 */
const ping = (url, timeout) => {
  const start = +new Date()
  return got(url, {
    retry: {
      retries(retry, error) {
        const now = +new Date()
        core.debug(
          `${now - start}ms ${error.method} ${error.host} ${
            error.code
          }`
        )
        if (now - start > timeout) {
          console.error('%s timed out', url)
          return 0
        }
        return 1000
      }
    }
  })
}

/**
 * Parses input command, finds the tool and
 * the runs the command.
 */
const execCommand = (
  fullCommand,
  waitToFinish = true,
  label = 'executing'
) => {
  const cwd = cypressCommandOptions.cwd

  console.log('%s with command "%s"', label, fullCommand)
  console.log('current working directory "%s"', cwd)

  const args = cliParser.parse(fullCommand)
  core.debug(`parsed command: ${args.join(' ')}`)

  return io.which(args[0], true).then(toolPath => {
    core.debug(`found command "${toolPath}"`)
    core.debug(`with arguments ${args.slice(1).join(' ')}`)

    const toolArguments = args.slice(1)
    const argsString = toolArguments.join(' ')
    core.debug(`running ${quote(toolPath)} ${argsString} in ${cwd}`)
    core.debug('without waiting for the promise to resolve')

    const promise = exec.exec(
      quote(toolPath),
      toolArguments,
      cypressCommandOptions
    )
    if (waitToFinish) {
      return promise
    }
  })
}

const isWindows = () => os.platform() === 'win32'

const homeDirectory = os.homedir()
const platformAndArch = `${process.platform}-${process.arch}`

const startWorkingDirectory = process.cwd()
const workingDirectory =
  core.getInput('working-directory') || process.cwd()

/**
 * When running "npm install" or any other Cypress-related commands,
 * use the install directory as current working directory
 */
const cypressCommandOptions = {
  cwd: workingDirectory
}

const yarnFilename = path.join(
  findYarnWorkspaceRoot(workingDirectory) || workingDirectory,
  'yarn.lock'
)
const packageLockFilename = path.join(
  workingDirectory,
  'package-lock.json'
)

const useYarn = () => fs.existsSync(yarnFilename)

const lockHash = () => {
  const lockFilename = useYarn() ? yarnFilename : packageLockFilename
  return hasha.fromFileSync(lockFilename)
}

// enforce the same NPM cache folder across different operating systems
const NPM_CACHE_FOLDER = path.join(homeDirectory, '.npm')
const getNpmCache = () => {
  const o = {}
  let key = core.getInput('cache-key')
  const hash = lockHash()
  if (!key) {
    if (useYarn()) {
      key = `yarn-${platformAndArch}-${hash}`
    } else {
      key = `npm-${platformAndArch}-${hash}`
    }
  } else {
    console.log('using custom cache key "%s"', key)
  }

  if (useYarn()) {
    o.inputPath = path.join(homeDirectory, '.cache', 'yarn')
  } else {
    o.inputPath = NPM_CACHE_FOLDER
  }

  o.restoreKeys = o.primaryKey = key
  return o
}

// custom Cypress binary cache folder
// see https://on.cypress.io/caching
const CYPRESS_CACHE_FOLDER = path.join(
  homeDirectory,
  '.cache',
  'Cypress'
)
core.debug(
  `using custom Cypress cache folder "${CYPRESS_CACHE_FOLDER}"`
)

const getCypressBinaryCache = () => {
  const o = {
    inputPath: CYPRESS_CACHE_FOLDER,
    restoreKeys: `cypress-${platformAndArch}-`
  }
  o.primaryKey = o.restoreKeys + lockHash()
  return o
}

const restoreCachedNpm = () => {
  core.debug('trying to restore cached NPM modules')
  const NPM_CACHE = getNpmCache()
  return restoreCache([NPM_CACHE.inputPath], NPM_CACHE.primaryKey, [
    NPM_CACHE.restoreKeys
  ])
}

const saveCachedNpm = () => {
  core.debug('saving NPM modules')
  const NPM_CACHE = getNpmCache()
  return saveCache([NPM_CACHE.inputPath], NPM_CACHE.primaryKey).catch(
    e => {
      console.warn('Saving NPM cache error: %s', e.message)
    }
  )
}

const restoreCachedCypressBinary = () => {
  core.debug('trying to restore cached Cypress binary')
  const CYPRESS_BINARY_CACHE = getCypressBinaryCache()
  return restoreCache(
    [CYPRESS_BINARY_CACHE.inputPath],
    CYPRESS_BINARY_CACHE.primaryKey,
    [CYPRESS_BINARY_CACHE.restoreKeys]
  )
}

const saveCachedCypressBinary = () => {
  core.debug('saving Cypress binary')
  const CYPRESS_BINARY_CACHE = getCypressBinaryCache()
  return saveCache(
    [CYPRESS_BINARY_CACHE.inputPath],
    CYPRESS_BINARY_CACHE.primaryKey
  ).catch(e => {
    console.warn('Saving Cypress cache error: %s', e.message)
  })
}

const install = () => {
  // prevent lots of progress messages during install
  core.exportVariable('CI', '1')
  core.exportVariable('CYPRESS_CACHE_FOLDER', CYPRESS_CACHE_FOLDER)

  // Note: need to quote found tool to avoid Windows choking on
  // npm paths with spaces like "C:\Program Files\nodejs\npm.cmd ci"

  if (useYarn()) {
    core.debug('installing NPM dependencies using Yarn')
    return io.which('yarn', true).then(yarnPath => {
      core.debug(`yarn at "${yarnPath}"`)
      return exec.exec(
        quote(yarnPath),
        ['--frozen-lockfile'],
        cypressCommandOptions
      )
    })
  } else {
    core.debug('installing NPM dependencies')
    core.exportVariable('npm_config_cache', NPM_CACHE_FOLDER)

    return io.which('npm', true).then(npmPath => {
      core.debug(`npm at "${npmPath}"`)
      return exec.exec(quote(npmPath), ['ci'], cypressCommandOptions)
    })
  }
}

const verifyCypressBinary = () => {
  core.debug('Verifying Cypress')
  core.exportVariable('CYPRESS_CACHE_FOLDER', CYPRESS_CACHE_FOLDER)
  return io.which('npx', true).then(npxPath => {
    return exec.exec(
      quote(npxPath),
      ['cypress', 'verify'],
      cypressCommandOptions
    )
  })
}

/**
 * Grabs a boolean GitHub Action parameter input and casts it.
 * @param {string} name - parameter name
 * @param {boolean} defaultValue - default value to use if the parameter was not specified
 * @returns {boolean} converted input argument or default value
 */
const getInputBool = (name, defaultValue = false) => {
  const param = core.getInput(name)
  if (param === 'true' || param === '1') {
    return true
  }
  if (param === 'false' || param === '0') {
    return false
  }

  return defaultValue
}

const buildAppMaybe = () => {
  const buildApp = core.getInput('build')
  if (!buildApp) {
    return
  }

  core.debug(`building application using "${buildApp}"`)

  return execCommand(buildApp, true, 'build app')
}

const startServerMaybe = () => {
  let startCommand

  if (isWindows()) {
    // allow custom Windows start command
    startCommand =
      core.getInput('start-windows') || core.getInput('start')
  } else {
    startCommand = core.getInput('start')
  }
  if (!startCommand) {
    core.debug('No start command found')
    return
  }

  return execCommand(startCommand, false, 'start server')
}

const waitOnMaybe = () => {
  const waitOn = core.getInput('wait-on')
  if (!waitOn) {
    return
  }

  const waitOnTimeout = core.getInput('wait-on-timeout') || '60'

  console.log(
    'waiting on "%s" with timeout of %s seconds',
    waitOn,
    waitOnTimeout
  )

  const waitTimeoutMs = parseFloat(waitOnTimeout) * 1000

  return ping(waitOn, waitTimeoutMs)
}

const I = x => x

/**
 * Asks Cypress API if there were already builds for this commit.
 * In that case increments the count to get unique parallel id.
 */
const getCiBuildId = async () => {
  const {
    GITHUB_WORKFLOW,
    GITHUB_SHA,
    GITHUB_TOKEN,
    GITHUB_RUN_ID,
    GITHUB_REPOSITORY
  } = process.env

  const [owner, repo] = GITHUB_REPOSITORY.split('/')
  let branch
  let parallelId = `${GITHUB_WORKFLOW} - ${GITHUB_SHA}`

  if (GITHUB_TOKEN) {
    core.debug(
      `Determining build id by asking GitHub about run ${GITHUB_RUN_ID}`
    )

    const client = new Octokit({
      auth: GITHUB_TOKEN
    })

    const resp = await client.request(
      'GET /repos/:owner/:repo/actions/runs/:run_id',
      {
        owner,
        repo,
        run_id: parseInt(GITHUB_RUN_ID)
      }
    )

    if (resp && resp.data && resp.data.head_branch) {
      branch = resp.data.head_branch
      core.debug(`found the branch name ${branch}`)
    }

    // This will return the complete list of jobs for a run with their steps,
    // this should always return data when there are jobs on the workflow.
    // Every time the workflow is re-run the jobs length should stay the same
    // (because the same amount of jobs were ran) but the id of them should change
    // letting us, select the first id as unique id
    // https://docs.github.com/en/rest/reference/actions#list-jobs-for-a-workflow-run
    const runsList = await client.request(
      'GET /repos/:owner/:repo/actions/runs/:run_id/jobs',
      {
        owner,
        repo,
        run_id: parseInt(GITHUB_RUN_ID)
      }
    )

    if (
      runsList &&
      runsList.data &&
      runsList.data.jobs &&
      runsList.data.jobs.length
    ) {
      const jobId = runsList.data.jobs[0].id
      core.debug(`fetched run list with jobId ${jobId}`)
      parallelId = `${GITHUB_RUN_ID}-${jobId}`
    } else {
      core.debug('could not get run list data')
    }
  }

  core.debug(
    `determined branch ${branch} and parallel id ${parallelId}`
  )
  return { branch, parallelId }
}

/**
 * Forms entire command line like "npx cypress run ..."
 */
const runTestsUsingCommandLine = async () => {
  core.debug('Running Cypress tests using CLI command')
  const quoteArgument = isWindows() ? quote : I

  const commandPrefix = core.getInput('command-prefix')
  if (!commandPrefix) {
    throw new Error('Expected command prefix')
  }

  const record = getInputBool('record')
  const parallel = getInputBool('parallel')
  const headless = getInputBool('headless')

  // TODO using yarn to run cypress when yarn is used for install
  // split potentially long command?

  let cmd = []
  // we need to split the command prefix into individual arguments
  // otherwise they are passed all as a single string
  const parts = commandPrefix.split(' ')
  cmd = cmd.concat(parts)
  core.debug(`with concatenated command prefix: ${cmd.join(' ')}`)

  // push each CLI argument separately
  cmd.push('cypress')
  cmd.push('run')
  if (headless) {
    cmd.push('--headless')
  }
  if (record) {
    cmd.push('--record')
  }
  if (parallel) {
    cmd.push('--parallel')
  }
  const group = core.getInput('group')
  if (group) {
    cmd.push('--group')
    cmd.push(quoteArgument(group))
  }
  const tag = core.getInput('tag')
  if (tag) {
    cmd.push('--tag')
    cmd.push(quoteArgument(tag))
  }
  const configInput = core.getInput('config')
  if (configInput) {
    cmd.push('--config')
    cmd.push(quoteArgument(configInput))
  }
  const spec = core.getInput('spec')
  if (spec) {
    cmd.push('--spec')
    cmd.push(quoteArgument(spec))
  }
  const project = core.getInput('project')
  if (project) {
    cmd.push('--project')
    cmd.push(quoteArgument(project))
  }
  const configFileInput = core.getInput('config-file')
  if (configFileInput) {
    cmd.push('--config-file')
    cmd.push(quoteArgument(configFileInput))
  }

  if (parallel || group) {
    const { branch, parallelId } = await getCiBuildId()
    if (branch) {
      core.exportVariable('GH_BRANCH', branch)
    }

    const customCiBuildId = core.getInput('ci-build-id') || parallelId
    cmd.push('--ci-build-id')
    cmd.push(quoteArgument(customCiBuildId))
  }

  const browser = core.getInput('browser')
  if (browser) {
    cmd.push('--browser')
    // TODO should browser be quoted?
    // If it is a path, it might have spaces
    cmd.push(browser)
  }

  const envInput = core.getInput('env')
  if (envInput) {
    // TODO should env be quoted?
    // If it is a JSON, it might have spaces
    cmd.push('--env')
    cmd.push(envInput)
  }

  const quiet = getInputBool('quiet')
  if (quiet) {
    cmd.push('--quiet')
  }

  console.log('Cypress test command: npx %s', cmd.join(' '))

  // since we have quoted arguments ourselves, do not double quote them
  const opts = {
    ...cypressCommandOptions,
    windowsVerbatimArguments: false
  }

  core.debug(`in working directory "${cypressCommandOptions.cwd}"`)

  const npxPath = await io.which('npx', true)
  core.debug(`npx path: ${npxPath}`)

  return exec.exec(quote(npxPath), cmd, opts)
}

/**
 * Run Cypress tests by collecting input parameters
 * and using Cypress module API to run tests.
 * @see https://on.cypress.io/module-api
 */
const runTests = async () => {
  const runTests = getInputBool('runTests', true)
  if (!runTests) {
    console.log('Skipping running tests: runTests parameter is false')
    return
  }

  // export common environment variables that help run Cypress
  core.exportVariable('CYPRESS_CACHE_FOLDER', CYPRESS_CACHE_FOLDER)
  core.exportVariable('TERM', 'xterm')

  const customCommand = core.getInput('command')
  if (customCommand) {
    console.log('Using custom test command: %s', customCommand)
    return execCommand(customCommand, true, 'run tests')
  }

  const commandPrefix = core.getInput('command-prefix')
  if (commandPrefix) {
    return runTestsUsingCommandLine()
  }

  core.debug('Running Cypress tests using NPM module API')
  core.debug(`requiring cypress dependency, cwd is ${process.cwd()}`)
  core.debug(`working directory ${workingDirectory}`)
  const cypressModulePath =
    require.resolve('cypress', {
      paths: [workingDirectory]
    }) || 'cypress'
  core.debug(`resolved cypress ${cypressModulePath}`)

  const cypress = require(cypressModulePath)
  const cypressOptions = {
    headless: getInputBool('headless'),
    record: getInputBool('record'),
    parallel: getInputBool('parallel'),
    quiet: getInputBool('quiet')
  }

  if (core.getInput('group')) {
    cypressOptions.group = core.getInput('group')
  }
  if (core.getInput('tag')) {
    cypressOptions.tag = core.getInput('tag')
  }
  if (core.getInput('config')) {
    cypressOptions.config = core.getInput('config')
    core.debug(`Cypress config "${cypressOptions.config}"`)
  }
  if (core.getInput('spec')) {
    cypressOptions.spec = core.getInput('spec')
  }
  if (core.getInput('config-file')) {
    cypressOptions.configFile = core.getInput('config-file')
  }

  // if the user set the explicit folder, use that
  if (core.getInput('project')) {
    cypressOptions.project = core.getInput('project')
  }
  if (core.getInput('browser')) {
    cypressOptions.browser = core.getInput('browser')
  }
  if (core.getInput('env')) {
    cypressOptions.env = core.getInput('env')
  }

  if (cypressOptions.parallel || cypressOptions.group) {
    const { branch, parallelId } = await getCiBuildId()
    if (branch) {
      core.exportVariable('GH_BRANCH', branch)
    }

    const customCiBuildId = core.getInput('ci-build-id') || parallelId
    if (customCiBuildId) {
      cypressOptions.ciBuildId = customCiBuildId
    }
  }

  core.debug(`Cypress options ${JSON.stringify(cypressOptions)}`)

  const onTestsFinished = testResults => {
    process.chdir(startWorkingDirectory)

    if (testResults.failures) {
      console.error('Test run failed, code %d', testResults.failures)
      if (testResults.message) {
        console.error(testResults.message)
      }

      return Promise.reject(
        new Error(testResults.message || 'Error running Cypress')
      )
    }

    core.debug(`Cypress tests: ${testResults.totalFailed} failed`)

    const dashboardUrl = testResults.runUrl
    core.debug(`Dashboard url ${dashboardUrl}`)
    core.setOutput('dashboardUrl', dashboardUrl)

    if (testResults.totalFailed) {
      return Promise.reject(
        new Error(`Cypress tests: ${testResults.totalFailed} failed`)
      )
    }
  }

  const onTestsError = e => {
    process.chdir(startWorkingDirectory)

    console.error(e)
    return Promise.reject(e)
  }

  process.chdir(workingDirectory)
  return cypress
    .run(cypressOptions)
    .then(onTestsFinished, onTestsError)
}

const installMaybe = () => {
  const installParameter = getInputBool('install', true)
  if (!installParameter) {
    console.log('Skipping install because install parameter is false')
    return Promise.resolve()
  }

  return Promise.all([
    restoreCachedNpm(),
    restoreCachedCypressBinary()
  ]).then(([npmCacheHit, cypressCacheHit]) => {
    core.debug(`npm cache hit ${npmCacheHit}`)
    core.debug(`cypress cache hit ${cypressCacheHit}`)

    return install().then(() => {
      if (npmCacheHit && cypressCacheHit) {
        core.debug('no need to verify Cypress binary or save caches')
        return Promise.resolve(undefined)
      }

      return verifyCypressBinary()
        .then(saveCachedNpm)
        .then(saveCachedCypressBinary)
    })
  })
}

installMaybe()
  .then(buildAppMaybe)
  .then(startServerMaybe)
  .then(waitOnMaybe)
  .then(runTests)
  .then(() => {
    core.debug('all done, exiting')
    // force exit to avoid waiting for child processes,
    // like the server we have started
    // see https://github.com/actions/toolkit/issues/216
    process.exit(0)
  })
  .catch(error => {
    // final catch - when anything goes wrong, throw an error
    // and exit the action with non-zero code
    core.debug(error.message)
    core.debug(error.stack)

    core.setFailed(error.message)
    process.exit(1)
  })
