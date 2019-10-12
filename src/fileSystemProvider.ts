import * as path from 'path';
import * as vscode from 'vscode';
import fetch from 'node-fetch';
import * as Url from 'url-parse';

export class File implements vscode.FileStat {
  type: vscode.FileType;
  ctime: number;
  mtime: number;
  size: number;

  name: string;
  data?: Uint8Array;
  dowloadUrl?: string;

  constructor(name: string, downloadUrl?: string) {
    this.type = vscode.FileType.File;
    this.ctime = Date.now();
    this.mtime = Date.now();
    this.size = 0;
    this.name = name;
    this.dowloadUrl = downloadUrl;
  }
}

export class Directory implements vscode.FileStat {
  type: vscode.FileType;
  ctime: number;
  mtime: number;
  size: number;

  name: string;
  entries: Map<string, File | Directory>;

  constructor(name: string) {
    this.type = vscode.FileType.Directory;
    this.ctime = Date.now();
    this.mtime = Date.now();
    this.size = 0;
    this.name = name;
    this.entries = new Map();
  }
}

export type Entry = File | Directory;

export class GitProviderFileSystem implements vscode.FileSystemProvider {
  repoUrl: string = '';
  root = new Directory('');

  constructor(private _context: vscode.ExtensionContext) {}

  // --- manage file metadata

  stat(uri: vscode.Uri): vscode.FileStat {
    return this._lookup(uri, false);
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    let entry = this._lookupAsDirectory(uri, false);
    if (!(entry && entry.entries.size)) {
      let res;
      try {
        res = await populateFiles(
          this._context.workspaceState.get('repoUrl', ''),
          uri.path
        );
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
        throw vscode.FileSystemError.Unavailable('Failed to fetch');
      }
      res.forEach(item => {
        if (item.type === vscode.FileType.Directory) {
          this.createDirectory(item.uri, { inMemory: true });
        } else {
          this.writeFile(
            item.uri,
            item.content!,
            {
              create: true,
              overwrite: true,
              inMemory: true,
            },
            item.downloadUrl
          );
        }
      });
    }
    entry = this._lookupAsDirectory(uri, false);
    let result: [string, vscode.FileType][] = [];
    for (const [name, child] of entry.entries) {
      result.push([name, child.type]);
    }
    return result;
  }

  // --- manage file contents

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    let entry = this._lookupAsFile(uri, false);
    if (entry.data) {
      if (entry.data.length === 0) {
        if (entry.dowloadUrl) {
          const content = await readFileContent(entry.dowloadUrl);
          this.writeFile(uri, content, {
            create: true,
            overwrite: true,
            inMemory: true,
          });
        }
      }
      if (entry.data) {
        return entry.data;
      }
    }
    throw vscode.FileSystemError.FileNotFound();
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean; inMemory: boolean },
    downloadUrl?: string
  ): void {
    if (!options.inMemory) {
      throw vscode.FileSystemError.NoPermissions(
        'You cannot write a file to a remote repo'
      );
    }
    let basename = path.posix.basename(uri.path);
    let parent = this._lookupParentDirectory(uri);
    let entry = parent.entries.get(basename);
    if (entry instanceof Directory) {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    if (!entry && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (entry && options.create && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (!entry) {
      entry = new File(basename, downloadUrl);
      parent.entries.set(basename, entry);
      this._fireSoon({ type: vscode.FileChangeType.Created, uri });
    }
    entry.mtime = Date.now();
    entry.size = content.byteLength;
    entry.data = content;

    this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
  }

  // --- manage files/folders

  rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean }
  ): void {
    throw vscode.FileSystemError.NoPermissions;
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(
      'You have no permission to delete this file'
    );
  }

  createDirectory(uri: vscode.Uri, options?: { inMemory: boolean }): void {
    // @ts-ignore
    if (!(options || {}).inMemory) {
      throw vscode.FileSystemError.NoPermissions(
        'You have no permission to create a directory'
      );
    }
    let basename = path.posix.basename(uri.path);
    let dirname = uri.with({ path: path.posix.dirname(uri.path) });
    let parent = this._lookupAsDirectory(dirname, false);

    let entry = new Directory(basename);
    parent.entries.set(entry.name, entry);
    parent.mtime = Date.now();
    parent.size += 1;
    this._fireSoon(
      { type: vscode.FileChangeType.Changed, uri: dirname },
      { type: vscode.FileChangeType.Created, uri }
    );
  }

  // --- lookup

  private _lookup(uri: vscode.Uri, silent: false): Entry;
  private _lookup(uri: vscode.Uri, silent: boolean): Entry | undefined;
  private _lookup(uri: vscode.Uri, silent: boolean): Entry | undefined {
    let parts = uri.path.split('/');
    let entry: Entry = this.root;
    for (const part of parts) {
      if (!part) {
        continue;
      }
      let child: Entry | undefined;
      if (entry instanceof Directory) {
        child = entry.entries.get(part);
      }
      if (!child) {
        if (!silent) {
          throw vscode.FileSystemError.FileNotFound(uri);
        } else {
          return undefined;
        }
      }
      entry = child;
    }
    return entry;
  }

  private _lookupAsDirectory(uri: vscode.Uri, silent: boolean): Directory {
    let entry = this._lookup(uri, silent);
    if (entry instanceof Directory) {
      return entry;
    }
    throw vscode.FileSystemError.FileNotADirectory(uri);
  }

  private _lookupAsFile(uri: vscode.Uri, silent: boolean): File {
    let entry = this._lookup(uri, silent);
    if (entry instanceof File) {
      return entry;
    }
    throw vscode.FileSystemError.FileIsADirectory(uri);
  }

  private _lookupParentDirectory(uri: vscode.Uri): Directory {
    const dirname = uri.with({ path: path.posix.dirname(uri.path) });
    return this._lookupAsDirectory(dirname, false);
  }

  // --- manage file events

  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private _bufferedEvents: vscode.FileChangeEvent[] = [];
  private _fireSoonHandle?: NodeJS.Timer;

  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this
    ._emitter.event;

  watch(_resource: vscode.Uri): vscode.Disposable {
    // ignore, fires for all changes...
    return new vscode.Disposable(() => {});
  }

  private _fireSoon(...events: vscode.FileChangeEvent[]): void {
    this._bufferedEvents.push(...events);

    if (this._fireSoonHandle) {
      clearTimeout(this._fireSoonHandle);
    }

    this._fireSoonHandle = setTimeout(() => {
      this._emitter.fire(this._bufferedEvents);
      this._bufferedEvents.length = 0;
    }, 5);
  }
}

type Item = {
  type: 'dir' | 'file';
  name: string;
  path: string;
  download_url: string;
};

const URI_SCHEME = 'GPFS';

const populateFiles = async (repoUrl: string, path: string) => {
  const apiUrl = `${getApiBaseUrl(repoUrl)}/contents/${stripSlash(path)}`;
  const res = await fetch(apiUrl);
  if (!res.ok) {
    const errorMessge = await res.text();
    throw new Error(errorMessge);
  }
  const data: Item[] = await res.json();

  return data.map(item => {
    if (item.path.startsWith('./')) {
      item.path = item.path.split('./')[1];
    }
    const uri = vscode.Uri.parse(`${URI_SCHEME}:/${item.path}`);
    if (item.type === 'dir') {
      return { uri, type: vscode.FileType.Directory };
    } else {
      var buf = Buffer.from('');
      const content = new Uint8Array(buf);
      return {
        uri,
        content,
        type: vscode.FileType.File,
        downloadUrl: item.download_url,
      };
    }
  });
};

const readFileContent = async (dowloadUrl: string) => {
  const res = await fetch(dowloadUrl);
  const text = await res.text();
  var buf = Buffer.from(text);
  const content = new Uint8Array(buf);
  return content;
};

const getApiBaseUrl = (repoUrl: string) => {
  const p = new Url(repoUrl);
  return `${p.protocol}//api.${stripSlash(p.hostname)}/repos/${stripSlash(
    p.pathname
  )}`;
};

const stripSlash = (str: string) => {
  return str.replace(/^\//, '').replace(/\/$/, '');
};
