/**
 * The script sandbox: importer scripts run in QuickJS compiled to WASM, with no network, no DOM,
 * no host functions, bounded memory and a time budget per call. See docs/plugins.md and
 * CLAUDE.md rule 6. Values cross the boundary as JSON only.
 */
import ReleaseSyncVariant from '@jitl/quickjs-wasmfile-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';

export interface SandboxLimits {
  /** Memory limit for the whole runtime, in bytes. Default 32 MiB. */
  memoryBytes?: number;
  /** Time budget for one call, in milliseconds. Default 200. */
  callMs?: number;
}

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptError';
  }
}

/** A compiled script: call it with JSON-compatible arguments. */
export type CompiledScript = (...args: unknown[]) => unknown;

export interface ScriptSandbox {
  compile(source: string): CompiledScript;
  dispose(): void;
}

let modulePromise: Promise<QuickJSWASMModule> | undefined;

function loadModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(ReleaseSyncVariant);
  return modulePromise;
}

class QuickJSSandbox implements ScriptSandbox {
  private readonly runtime: QuickJSRuntime;
  private readonly context: QuickJSContext;
  private readonly handles: QuickJSHandle[] = [];
  private readonly callMs: number;

  constructor(module: QuickJSWASMModule, limits: SandboxLimits) {
    this.runtime = module.newRuntime();
    this.runtime.setMemoryLimit(limits.memoryBytes ?? 32 * 1024 * 1024);
    this.runtime.setMaxStackSize(512 * 1024);
    this.callMs = limits.callMs ?? 200;
    this.context = this.runtime.newContext();
  }

  compile(source: string): CompiledScript {
    const vm = this.context;
    // Wrap the user's function so arguments and the result cross as JSON strings.
    const wrapper = `(function () {
      const f = (${source});
      if (typeof f !== 'function') throw new TypeError('a script must be a function');
      return function (json) {
        const result = f.apply(undefined, JSON.parse(json));
        return JSON.stringify(result === undefined ? null : result);
      };
    })()`;
    const fn = this.guard(() => vm.unwrapResult(vm.evalCode(wrapper, 'importer-script.js')));
    this.handles.push(fn);
    return (...args: unknown[]) => {
      const arg = vm.newString(JSON.stringify(args));
      try {
        const json = this.guard(() => {
          const handle = vm.unwrapResult(vm.callFunction(fn, vm.undefined, arg));
          try {
            return vm.getString(handle);
          } finally {
            handle.dispose();
          }
        });
        return JSON.parse(json) as unknown;
      } finally {
        arg.dispose();
      }
    };
  }

  /** Run with a deadline; turn QuickJS errors into ScriptErrors. */
  private guard<T>(f: () => T): T {
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.callMs));
    try {
      return f();
    } catch (error) {
      const e = error as { name?: string; message?: string };
      const message = e.message ?? String(error);
      throw new ScriptError(/interrupted/i.test(message) ? 'script took too long' : message);
    } finally {
      this.runtime.removeInterruptHandler();
    }
  }

  dispose(): void {
    for (const h of this.handles.splice(0)) h.dispose();
    this.context.dispose();
    this.runtime.dispose();
  }
}

/** Create a sandbox. Load once per import run and dispose afterwards. */
export async function createSandbox(limits: SandboxLimits = {}): Promise<ScriptSandbox> {
  return new QuickJSSandbox(await loadModule(), limits);
}
