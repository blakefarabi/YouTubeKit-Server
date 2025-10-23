import { newQuickJSWASMModule } from 'quickjs-emscripten';
import { RELEASE_SYNC } from 'quickjs-emscripten/variants';
import { newVariant } from 'quickjs-emscripten-core';
import wasmModule from '../quickjs.wasm';

// Types from youtubei.js PlatformShim
type VMPrimative = string | number | boolean | null | undefined;

interface BuildScriptResult {
	output: string;
	exported: string[];
	exportedRawValues?: Record<string, any>;
}

type EvalResult = {
	[key: string]: any;
} | void;

// Create Cloudflare-specific variant with directly imported WASM
const cloudflareVariant = newVariant(RELEASE_SYNC, { wasmModule });

let quickJSModule: Awaited<ReturnType<typeof newQuickJSWASMModule>> | null = null;

async function getQuickJSModule() {
	if (!quickJSModule) {
		quickJSModule = await newQuickJSWASMModule(cloudflareVariant);
	}
	return quickJSModule;
}

export async function evaluateJavaScript(data: BuildScriptResult, env: Record<string, VMPrimative>): Promise<EvalResult> {
	const QuickJS = await getQuickJSModule();
	const vm = QuickJS.newContext();

	try {
		// Build the code to execute
		const properties = [];

		if (env.n) {
			properties.push(`n: exportedVars.nFunction("${env.n}")`);
		}

		if (env.sig) {
			properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
		}

		// Wrap the code in an IIFE to allow the return statement
		const code = `(function() {\n${data.output}\nreturn { ${properties.join(', ')} };\n})()`;

		// Evaluate the code
		const result = vm.evalCode(code);

		if (result.error) {
			const error = vm.dump(result.error);
			result.error.dispose();
			throw new Error(`QuickJS evaluation error: ${JSON.stringify(error)}`);
		}

		// Extract the result
		const jsResult = vm.dump(result.value);
		result.value.dispose();

		return jsResult as EvalResult;
	} catch (error) {
		console.error('Error in QuickJS evaluator:', error);
		throw error;
	} finally {
		vm.dispose();
	}
}
