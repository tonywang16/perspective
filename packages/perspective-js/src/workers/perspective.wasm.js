/******************************************************************************
 *
 * Copyright (c) 2017, the Perspective Authors.
 *
 * This file is part of the Perspective library, distributed under the terms of
 * the Apache License 2.0.  The full license can be found in the LICENSE file.
 *
 */

import { createRuntime } from "@jpmorganchase/perspective-runtime";

const load_perspective = require("../../obj/psp.async.js").load_perspective;

if (global.document !== undefined && typeof WebAssembly !== "undefined") {
    module.exports = createRuntime(
        load_perspective({
            wasmJSMethod: "native-wasm",
            printErr: x => console.error(x),
            print: x => console.log(x)
        })
    );
} else {
    module.exports = createRuntime(load_perspective);
}
