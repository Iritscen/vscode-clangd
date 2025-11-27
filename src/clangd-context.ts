import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';
import * as vscodelcAsync from 'vscode-languageclient/lib/common/utils/async';

import * as ast from './ast';
import * as config from './config';
import * as configFileWatcher from './config-file-watcher';
import * as fileStatus from './file-status';
import * as inactiveRegions from './inactive-regions';
import * as inlayHints from './inlay-hints';
import * as install from './install';
import * as memoryUsage from './memory-usage';
import * as openConfig from './open-config';
import * as switchSourceHeader from './switch-source-header';
import * as typeHierarchy from './type-hierarchy';

export const clangdDocumentSelector = [
  {scheme: 'file', language: 'c'},
  {scheme: 'file', language: 'cpp'},
  {scheme: 'file', language: 'cuda-cpp'},
  {scheme: 'file', language: 'objective-c'},
  {scheme: 'file', language: 'objective-cpp'},
];

export function isClangdDocument(document: vscode.TextDocument) {
  return vscode.languages.match(clangdDocumentSelector, document);
}

class ClangdLanguageClient extends vscodelc.LanguageClient {
  // Override the default implementation for failed requests. The default
  // behavior is just to log failures in the output panel, however output panel
  // is designed for extension debugging purpose, normal users will not open it,
  // thus when the failure occurs, normal users doesn't know that.
  //
  // For user-interactive operations (e.g. applyFixIt, applyTweaks), we will
  // prompt up the failure to users.

  handleFailedRequest<T>(type: vscodelc.MessageSignature, error: any,
                         token: vscode.CancellationToken|undefined,
                         defaultValue: T): T {
    if (error instanceof vscodelc.ResponseError &&
        type.method === 'workspace/executeCommand')
      vscode.window.showErrorMessage(error.message);

    return super.handleFailedRequest(type, token, error, defaultValue);
  }
}

class EnableEditsNearCursorFeature implements vscodelc.StaticFeature {
  initialize() {}
  fillClientCapabilities(capabilities: vscodelc.ClientCapabilities): void {
    const extendedCompletionCapabilities: any =
        capabilities.textDocument?.completion;
    extendedCompletionCapabilities.editsNearCursor = true;
  }
  getState(): vscodelc.FeatureState { return {kind: 'static'}; }
  clear() {}
}

export class ClangdContext implements vscode.Disposable {
  subscriptions: vscode.Disposable[];
  client: ClangdLanguageClient;

  diagnosticsHandle = vscode.languages.createDiagnosticCollection("Delayed diagnostics");
  diagnosticsCache: Map<string, vscode.Diagnostic[]> = new Map();
  defaultDiagnosticsDelayAfterEdit = 0.75;
  userDiagnosticsDelayAfterEdit = this.defaultDiagnosticsDelayAfterEdit;
  postEditDelayer = new vscodelcAsync.Delayer<void>(this.userDiagnosticsDelayAfterEdit * 1000);
  lastLineCursor = 0;
  diagnosticsWaitForLineChange = false;
  noDelayOnNextDiag = false;
  curLineCount = 0;
  diagnosticsWaitForFileSave = false;

  static async create(globalStoragePath: string,
                      outputChannel: vscode.OutputChannel):
      Promise<ClangdContext|null> {
    const subscriptions: vscode.Disposable[] = [];
    const clangdPath = await install.activate(subscriptions, globalStoragePath);
    if (!clangdPath) {
      subscriptions.forEach((d) => { d.dispose(); });
      return null;
    }

    return new ClangdContext(subscriptions, await ClangdContext.createClient(
                                                clangdPath, outputChannel));
  }

  private static async createClient(clangdPath: string,
                                    outputChannel: vscode.OutputChannel):
      Promise<ClangdLanguageClient> {
    const useScriptAsExecutable =
        await config.get<boolean>('useScriptAsExecutable');
    let clangdArguments = await config.get<string[]>('arguments');
    if (useScriptAsExecutable) {
      let quote = (str: string) => { return `"${str}"`; };
      clangdPath = quote(clangdPath)
      for (var i = 0; i < clangdArguments.length; i++) {
        clangdArguments[i] = quote(clangdArguments[i]);
      }
    }
    const clangd: vscodelc.Executable = {
      command: clangdPath,
      args: clangdArguments,
      options: {
        cwd: vscode.workspace.rootPath || process.cwd(),
        shell: useScriptAsExecutable
      }
    };
    const traceFile = await config.get<string>('trace');
    if (!!traceFile) {
      const trace = {CLANGD_TRACE: traceFile};
      clangd.options = {...clangd.options, env: {...process.env, ...trace}};
    }
    const serverOptions: vscodelc.ServerOptions = clangd;

    const clientOptions: vscodelc.LanguageClientOptions = {
      // Register the server for c-family and cuda files.
      documentSelector: clangdDocumentSelector,
      initializationOptions: {
        clangdFileStatus: true,
        fallbackFlags: await config.get<string[]>('fallbackFlags')
      },
      outputChannel: outputChannel,
      // Do not switch to output window when clangd returns output.
      revealOutputChannelOn: vscodelc.RevealOutputChannelOn.Never,

      // We hack up the completion items a bit to prevent VSCode from re-ranking
      // and throwing away all our delicious signals like type information.
      //
      // VSCode sorts by (fuzzymatch(prefix, item.filterText), item.sortText)
      // By adding the prefix to the beginning of the filterText, we get a
      // perfect
      // fuzzymatch score for every item.
      // The sortText (which reflects clangd ranking) breaks the tie.
      // This also prevents VSCode from filtering out any results due to the
      // differences in how fuzzy filtering is applies, e.g. enable dot-to-arrow
      // fixes in completion.
      //
      // We also mark the list as incomplete to force retrieving new rankings.
      // See https://github.com/microsoft/language-server-protocol/issues/898
      middleware: {
        provideCompletionItem: async (document, position, context, token,
                                      next) => {
          if (!await config.get<boolean>('enableCodeCompletion'))
            return new vscode.CompletionList([], /*isIncomplete=*/ false);
          let list = await next(document, position, context, token);
          if (!await config.get<boolean>('serverCompletionRanking'))
            return list;
          let items = (!list ? [] : Array.isArray(list) ? list : list.items);
          items = items.map(item => {
            // Gets the prefix used by VSCode when doing fuzzymatch.
            let prefix = document.getText(
                new vscode.Range((item.range as vscode.Range).start, position))
            if (prefix)
            item.filterText = prefix + '_' + item.filterText;
            // Workaround for https://github.com/clangd/vscode-clangd/issues/357
            // clangd's used of commit-characters was well-intentioned, but
            // overall UX is poor. Due to vscode-languageclient bugs, we didn't
            // notice until the behavior was in several releases, so we need
            // to override it on the client.
            item.commitCharacters = [];
            // VSCode won't automatically trigger signature help when entering
            // a placeholder, e.g. if the completion inserted brackets and
            // placed the cursor inside them.
            // https://github.com/microsoft/vscode/issues/164310
            // They say a plugin should trigger this, but LSP has no mechanism.
            // https://github.com/microsoft/language-server-protocol/issues/274
            // (This workaround is incomplete, and only helps the first param).
            if (item.insertText instanceof vscode.SnippetString &&
                !item.command &&
                item.insertText.value.match(/[([{<,] ?\$\{?[01]\D/))
              item.command = {
                title: 'Signature help',
                command: 'editor.action.triggerParameterHints'
              };
            return item;
          })
          return new vscode.CompletionList(items, /*isIncomplete=*/ true);
        },
        provideHover: async (document, position, token, next) => {
          if (!await config.get<boolean>('enableHover'))
            return null;
          return next(document, position, token);
        },
        // VSCode applies fuzzy match only on the symbol name, thus it throws
        // away all results if query token is a prefix qualified name.
        // By adding the containerName to the symbol name, it prevents VSCode
        // from filtering out any results, e.g. enable workspaceSymbols for
        // qualified symbols.
        provideWorkspaceSymbols: async (query, token, next) => {
          let symbols = await next(query, token);
          return symbols?.map(symbol => {
            // Only make this adjustment if the query is in fact qualified.
            // Otherwise, we get a suboptimal ordering of results because
            // including the name's qualifier (if it has one) in symbol.name
            // means vscode can no longer tell apart exact matches from
            // partial matches.
            if (query.includes('::')) {
              if (symbol.containerName)
                symbol.name = `${symbol.containerName}::${symbol.name}`;
              // results from clangd strip the leading '::', so vscode fuzzy
              // match will filter out all results unless we add prefix back in
              if (query.startsWith('::')) {
                symbol.name = `::${symbol.name}`;
              }
              // Clean the containerName to avoid displaying it twice.
              symbol.containerName = '';
            }
            return symbol;
          })
        }
      }
    };

    const client = new ClangdLanguageClient('Clang Language Server',
                                            serverOptions, clientOptions);
    client.clientOptions.errorHandler = client.createDefaultErrorHandler(
        // max restart count
        await config.get<boolean>('restartAfterCrash') ? /*default*/ 4 : 0);
    client.registerFeature(new EnableEditsNearCursorFeature);

    return client;
  }

  private constructor(subscriptions: vscode.Disposable[],
                      client: ClangdLanguageClient) {
    this.subscriptions = subscriptions;
    this.client = client;

    // Add onto middleware hooks with an async function so that we can call config.get()
    this.overrideDiagnostics();
    
    this.startClient();
  }

  async overrideDiagnostics() {
    const context = this; // create closure for accessing ClangdContext members
    context.userDiagnosticsDelayAfterEdit = await config.get<number>('diagnosticsDelay.afterTyping') ?? this.defaultDiagnosticsDelayAfterEdit;
    context.postEditDelayer = new vscodelcAsync.Delayer<void>(this.userDiagnosticsDelayAfterEdit * 1000);
    context.diagnosticsWaitForLineChange = await config.get<boolean>('diagnosticsDelay.untilLineChange') ?? false;
    context.diagnosticsWaitForFileSave = await config.get<boolean>('diagnosticsDelay.untilFileSave') ?? false;
    
    const originalMiddleware = this.client.clientOptions.middleware || {};
    
    this.client.clientOptions.middleware = {
      ...originalMiddleware,
      handleDiagnostics: (uri, diagnostics, next) => {
        // Delay the displaying of diagnostics if:
        // 1. They are non-empty AND
        // 2. The user asked for diagnostics to be delayed
        // Rule #1 means that regardless of user settings we will always update diagnostics immediately if the document's new diagnostics
        // state is a clean bill of health (no errors, no warnings) rather than leaving stale diagnostics on-screen
        if (diagnostics.length > 0 && (context.userDiagnosticsDelayAfterEdit > 0.0 ||
                                       (context.diagnosticsWaitForLineChange && !context.noDelayOnNextDiag) ||
                                       context.diagnosticsWaitForFileSave))
          context.diagnosticsCache.set(uri.toString(), diagnostics); // save diagnostics for later
        else
        {
          context.diagnosticsCache.clear(); // prevent outdated cache from appearing after this

          // Let diagnostics pass through to client, but we have to do this through our custom diagnostics collection, not by calling
          // "next(uri, diagnostics)", because the custom collection overrides the built-in diagnostics
          context.diagnosticsHandle.set(uri, diagnostics);
        }

        context.noDelayOnNextDiag = false;
      },
      didChange: async (event, next) => {
        // If diagnosticsWaitForLineChange is turned on, then if the user types something, waits long enough for diagnostics to return (knowingly or not),
        // then changes lines and types something, diagnostics will display immediately for the current line, so we reset noDelayOnNextDiag here as a safeguard
        context.noDelayOnNextDiag = false;

        if (context.userDiagnosticsDelayAfterEdit > 0.0)
        {
          context.postEditDelayer.cancel();
          context.postEditDelayer.trigger(() => { context.revealDiagnostics(); }); // restart timer
        }
        else if (context.diagnosticsWaitForLineChange)
        {
          if (context.curLineCount == 0) // this probably means we just opened the project, so simply save our current line count
            context.curLineCount = event.document.lineCount;
          else
          {
            for (const change of event.contentChanges)
            {
              if (event.document.lineCount != context.curLineCount) // at least one line of content was added or removed, which counts as a line change
              {
                context.diagnosticsCache.clear(); // prevent outdated diags from appearing after this edit; instead we'll show the next diags as soon as they arrive
                context.noDelayOnNextDiag = true;
                context.curLineCount = event.document.lineCount;
                break;
              }
            }
          }
        }

        // Allow document change to be processed
        next(event);
      },
      didSave: async (document, next) => {
        if (context.diagnosticsWaitForFileSave) {
          context.revealDiagnostics();
        }
        
        next(document);
      }
    };
  }

  async startClient() {
    typeHierarchy.activate(this);
    inlayHints.activate(this);
    memoryUsage.activate(this);
    ast.activate(this);
    openConfig.activate(this);
    inactiveRegions.activate(this);
    await configFileWatcher.activate(this);
    this.client.start();
    console.log('Clang Language Server is now active!');
    fileStatus.activate(this);
    switchSourceHeader.activate(this);
  }

  get visibleClangdEditors(): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter(
        (e) => isClangdDocument(e.document));
  }

  clientIsStarting() {
    return this.client && this.client.state == vscodelc.State.Starting;
  }

  clientIsRunning() {
    return this.client && this.client.state == vscodelc.State.Running;
  }

  dispose() {
    this.subscriptions.forEach((d) => { d.dispose(); });
    if (this.client)
      this.client.stop();
    this.subscriptions = []
  }

  // Send to VSC the last diagnostics received from clangd
  revealDiagnostics()
  {
    for (const [key, diagnostics] of this.diagnosticsCache)
    {
        const uri = vscode.Uri.parse(key);
        this.diagnosticsHandle.set(uri, diagnostics);
    }

    this.diagnosticsCache.clear();
    this.noDelayOnNextDiag = false;
  }

  // React to a change in the position of the text cursor
  cursorMoved(newLine : number)
  {
    // If lastLineCursor is 0, this probably means we just opened the project, so don't take action this first time that the line is set
    if (this.diagnosticsWaitForLineChange && newLine !== this.lastLineCursor && this.lastLineCursor != 0)
    {
      // Show existing diagnostics, but also set noDelayOnNextDiag to true because if the user just pasted something in,
      // it's the next diags which will contain the response to the pasted text
      this.revealDiagnostics();
      this.noDelayOnNextDiag = true;
    }

    this.lastLineCursor = newLine;
  }

  // React to user changing the diagnostics delay
  async updateDelay()
  {
    this.userDiagnosticsDelayAfterEdit = await config.get<number>('diagnosticsDelay.afterTyping') ?? this.defaultDiagnosticsDelayAfterEdit;
    this.postEditDelayer = new vscodelcAsync.Delayer<void>(this.userDiagnosticsDelayAfterEdit * 1000);
  }
}