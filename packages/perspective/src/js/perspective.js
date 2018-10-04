/******************************************************************************
 *
 * Copyright (c) 2017, the Perspective Authors.
 *
 * This file is part of the Perspective library, distributed under the terms of
 * the Apache License 2.0.  The full license can be found in the LICENSE file.
 *
 */

import {AGGREGATE_DEFAULTS, FILTER_DEFAULTS, SORT_ORDERS, TYPE_AGGREGATES, TYPE_FILTERS, COLUMN_SEPARATOR_STRING} from "./defaults.js";
import {DateParser, is_valid_date} from "./date_parser.js";

import {Precision} from "@apache-arrow/es5-esm/type";
import {Table} from "@apache-arrow/es5-esm/table";
import {TypeVisitor} from "@apache-arrow/es5-esm/visitor";
import formatters from "./view_formatters";
import papaparse from "papaparse";

// IE fix - chrono::steady_clock depends on performance.now() which does not exist in IE workers
if (global.performance === undefined) {
    global.performance = {now: Date.now};
}

if (typeof self !== "undefined" && self.performance === undefined) {
    self.performance = {now: Date.now};
}

const CHUNKED_THRESHOLD = 100000;

module.exports = function(Module) {
    let __MODULE__ = Module;

    /******************************************************************************
     *
     * Private
     *
     */

    /**
     * Infer the t_dtype of a value.
     * @private
     * @returns A t_dtype.
     */
    function infer_type(x) {
        let t = __MODULE__.t_dtype.DTYPE_FLOAT64;
        if (x === null) {
            t = null;
        } else if (typeof x === "number" && x % 1 === 0 && x < 10000 && x !== 0) {
            t = __MODULE__.t_dtype.DTYPE_INT32;
        } else if (typeof x === "number") {
            t = __MODULE__.t_dtype.DTYPE_FLOAT64;
        } else if (typeof x === "boolean") {
            t = __MODULE__.t_dtype.DTYPE_BOOL;
        } else if (x instanceof Date) {
            t = __MODULE__.t_dtype.DTYPE_TIME;
        } else if (!isNaN(Number(x)) && x !== "") {
            t = __MODULE__.t_dtype.DTYPE_FLOAT64;
        } else if (typeof x === "string" && is_valid_date(x)) {
            t = __MODULE__.t_dtype.DTYPE_TIME;
        } else if (typeof x === "string") {
            let lower = x.toLowerCase();
            if (lower === "true" || lower === "false") {
                t = __MODULE__.t_dtype.DTYPE_BOOL;
            } else {
                t = __MODULE__.t_dtype.DTYPE_STR;
            }
        }
        return t;
    }

    /**
     * Gets human-readable types for a column
     * @private
     * @returns {string}
     */
    function get_column_type(val) {
        if (val === 1 || val === 2) {
            return "integer";
        } else if (val === 19) {
            return "string";
        } else if (val === 10 || val === 9) {
            return "float";
        } else if (val === 11) {
            return "boolean";
        } else if (val === 12) {
            return "date";
        }
    }

    /**
     * Do any necessary data transforms on columns. Currently it does the following
     * transforms
     * 1. Date objects are converted into float millis since epoch
     * 2. Null strings are converted into null values
     *
     * @private
     * @param {string} type type of column
     * @param {array} data array of columnar data
     *
     * @returns transformed array of columnar data
     */
    function transform_data(type, data) {
        let rv = [];
        for (let x = 0; x < data.length; x++) {
            let tmp = clean_data(data[x]);

            if (type == __MODULE__.t_dtype.DTYPE_TIME && tmp !== null) {
                tmp = +data[x];
            }

            rv.push(tmp);
        }
        return rv;
    }

    /**
     * Coerce string null into value null
     * @param {*} value
     */
    function clean_data(value) {
        if (value === null || value === "null") {
            return null;
        } else {
            return value;
        }
    }

    /**
     * Converts any supported input type into a canonical representation for
     * interfacing with perspective.
     *
     * @private
     * @param {object} data See docs
     * @returns An object with 3 properties:
     *    names - the column names.
     *    types - the column t_dtypes.
     *    cdata - an array of columnar data.
     */
    function parse_data(data, names, types) {
        // todo: refactor, treat columnar/row data as the same to marshal values + fix null handling
        let preloaded = types ? true : false;
        if (types === undefined) {
            types = [];
        } else {
            let _types = [];
            for (let t = 0; t < types.size() - 1; t++) {
                _types.push(types.get(t));
            }
            types = _types;
        }
        let cdata = [];

        let row_count = 0;

        if (Array.isArray(data)) {
            // Row oriented
            if (data.length === 0) {
                throw "Not yet implemented: instantiate empty grid without column type";
            }
            let max_check = 50;
            if (names === undefined) {
                names = Object.keys(data[0]);
                for (let ix = 0; ix < Math.min(max_check, data.length); ix++) {
                    let next = Object.keys(data[ix]);
                    if (names.length !== next.length) {
                        if (next.length > names.length) {
                            if (max_check === 50) console.warn("Array data has inconsistent rows");
                            console.warn("Extending from " + names.length + " to " + next.length);
                            names = next;
                            max_check *= 2;
                        }
                    }
                }
            }
            for (let n in names) {
                let name = names[n];
                let i = 0,
                    inferredType = undefined;
                if (!preloaded) {
                    while (!inferredType && i < 100 && i < data.length) {
                        if (data[i].hasOwnProperty(name)) {
                            inferredType = infer_type(data[i][name]);
                        }
                        i++;
                    }
                    inferredType = inferredType || __MODULE__.t_dtype.DTYPE_STR;
                    types.push(inferredType);
                } else {
                    inferredType = types[parseInt(n)];
                }
                if (inferredType === undefined) {
                    console.warn(`Could not infer type for column ${name}`);
                    inferredType = __MODULE__.t_dtype.DTYPE_STR;
                }
                let col = [];
                const parser = new DateParser();
                for (let x = 0; x < data.length; x++) {
                    if (!(name in data[x]) || clean_data(data[x][name]) === undefined) {
                        col.push(undefined);
                        continue;
                    }
                    if (inferredType.value === __MODULE__.t_dtype.DTYPE_FLOAT64.value) {
                        let val = clean_data(data[x][name]);
                        if (val !== null) {
                            val = Number(val);
                        }
                        col.push(val);
                    } else if (inferredType.value === __MODULE__.t_dtype.DTYPE_INT32.value) {
                        let val = clean_data(data[x][name]);
                        if (val !== null) val = Number(val);
                        col.push(val);
                        if (val > 2147483647 || val < -2147483648) {
                            types[n] = __MODULE__.t_dtype.DTYPE_FLOAT64;
                        }
                    } else if (inferredType.value === __MODULE__.t_dtype.DTYPE_BOOL.value) {
                        let cell = clean_data(data[x][name]);
                        if (cell === null) {
                            col.push(null);
                            continue;
                        }

                        if (typeof cell === "string") {
                            if (cell.toLowerCase() === "true") {
                                col.push(true);
                            } else {
                                col.push(false);
                            }
                        } else {
                            col.push(!!cell);
                        }
                    } else if (inferredType.value === __MODULE__.t_dtype.DTYPE_TIME.value) {
                        let val = clean_data(data[x][name]);
                        if (val !== null) {
                            col.push(parser.parse(val));
                        } else {
                            col.push(null);
                        }
                    } else {
                        let val = clean_data(data[x][name]);
                        // types[types.length - 1].value === 19 ? "" : 0
                        col.push(val === null ? null : "" + val); // TODO this is not right - might not be a string.  Need a data cleaner
                    }
                }
                cdata.push(col);
                row_count = col.length;
            }
        } else if (Array.isArray(data[Object.keys(data)[0]])) {
            // Column oriented update. Extending schema not supported here.

            const names_in_update = Object.keys(data);
            row_count = data[names_in_update[0]].length;
            names = names || names_in_update;

            for (let col_num = 0; col_num < names.length; col_num++) {
                const name = names[col_num];

                // Infer column type if necessary
                if (!preloaded) {
                    let i = 0;
                    let inferredType = null;
                    while (inferredType === null && i < 100 && i < data[name].length) {
                        inferredType = infer_type(data[name][i]);
                        i++;
                    }
                    inferredType = inferredType || __MODULE__.t_dtype.DTYPE_STR;
                    types.push(inferredType);
                }

                // Extract the data or fill with undefined if column doesn't exist (nothing in column changed)
                let transformed;
                if (data.hasOwnProperty(name)) {
                    transformed = transform_data(types[col_num], data[name]);
                } else {
                    transformed = new Array(row_count);
                }
                cdata.push(transformed);
            }
        } else if (typeof data[Object.keys(data)[0]] === "string" || typeof data[Object.keys(data)[0]] === "function") {
            //if (this.initialized) {
            //  throw "Cannot update already initialized table with schema.";
            // }
            names = [];

            // Empty type dict
            for (let name in data) {
                names.push(name);
                if (data[name] === "integer") {
                    types.push(__MODULE__.t_dtype.DTYPE_INT32);
                } else if (data[name] === "float") {
                    types.push(__MODULE__.t_dtype.DTYPE_FLOAT64);
                } else if (data[name] === "string") {
                    types.push(__MODULE__.t_dtype.DTYPE_STR);
                } else if (data[name] === "boolean") {
                    types.push(__MODULE__.t_dtype.DTYPE_BOOL);
                } else if (data[name] === "date") {
                    types.push(__MODULE__.t_dtype.DTYPE_TIME);
                } else {
                    throw `Unknown type ${data[name]}`;
                }
                cdata.push([]);
            }
        } else {
            throw "Unknown data type";
        }

        return {
            row_count: row_count,
            is_arrow: false,
            names: names,
            types: types,
            cdata: cdata
        };
    }

    /**
     * Converts arrow data into a canonical representation for
     * interfacing with perspective.
     *
     * @private
     * @param {object} data Array buffer
     * @returns An object with 3 properties:
     */
    function load_arrow_buffer(data) {
        // TODO Need to validate that the names/types passed in match those in the buffer
        let arrow = Table.from([new Uint8Array(data)]);
        let loader = arrow.schema.fields.reduce((loader, field, colIdx) => {
            return loader.loadColumn(field, arrow.getColumnAt(colIdx));
        }, new ArrowColumnLoader());
        return {
            row_count: arrow.length,
            is_arrow: true,
            names: loader.names,
            types: loader.types,
            cdata: loader.cdata
        };
    }

    /**
     *
     * @private
     */
    class ArrowColumnLoader extends TypeVisitor {
        constructor(cdata, names, types) {
            super();
            this.cdata = cdata || [];
            this.names = names || [];
            this.types = types || [];
        }
        loadColumn(field /*: Arrow.type.Field*/, column /*: Arrow.Vector*/) {
            if (this.visit(field.type)) {
                this.cdata.push(column);
                this.names.push(field.name);
            }
            return this;
        }
        // visitNull(type/*: Arrow.type.Null*/) {}
        visitBool(/* type: Arrow.type.Bool */) {
            this.types.push(__MODULE__.t_dtype.DTYPE_BOOL);
            return true;
        }
        visitInt(type /* : Arrow.type.Int */) {
            const bitWidth = type.bitWidth;
            if (bitWidth === 64) {
                this.types.push(__MODULE__.t_dtype.DTYPE_INT64);
            } else if (bitWidth === 32) {
                this.types.push(__MODULE__.t_dtype.DTYPE_INT32);
            } else if (bitWidth === 16) {
                this.types.push(__MODULE__.t_dtype.DTYPE_INT16);
            } else if (bitWidth === 8) {
                this.types.push(__MODULE__.t_dtype.DTYPE_INT8);
            }
            return true;
        }
        visitFloat(type /* : Arrow.type.Float */) {
            const precision = type.precision;
            if (precision === Precision.DOUBLE) {
                this.types.push(__MODULE__.t_dtype.DTYPE_FLOAT64);
            } else if (precision === Precision.SINGLE) {
                this.types.push(__MODULE__.t_dtype.DTYPE_FLOAT32);
            }
            // todo?
            // else if (type.precision === Arrow.enum_.Precision.HALF) {
            //     this.types.push(__MODULE__.t_dtype.DTYPE_FLOAT16);
            // }
            return true;
        }
        visitUtf8(/* type: Arrow.type.Utf8 */) {
            this.types.push(__MODULE__.t_dtype.DTYPE_STR);
            return true;
        }
        visitBinary(/* type: Arrow.type.Binary */) {
            this.types.push(__MODULE__.t_dtype.DTYPE_STR);
            return true;
        }
        // visitFixedSizeBinary(type/*: Arrow.type.FixedSizeBinary*/) {}
        // visitDate(type/*: Arrow.type.Date_*/) {}
        visitTimestamp(/* type: Arrow.type.Timestamp */) {
            this.types.push(__MODULE__.t_dtype.DTYPE_TIME);
            return true;
        }
        // visitTime(type/*: Arrow.type.Time*/) {}
        // visitDecimal(type/*: Arrow.type.Decimal*/) {}
        // visitList(type/*: Arrow.type.List*/) {}
        // visitStruct(type/*: Arrow.type.Struct*/) {}
        // visitUnion(type/*: Arrow.type.Union<any>*/) {}
        visitDictionary(type /*: Arrow.type.Dictionary */) {
            return this.visit(type.dictionary);
        }
        // visitInterval(type/*: Arrow.type.Interval*/) {}
        // visitFixedSizeList(type/*: Arrow.type.FixedSizeList*/) {}
        // visitMap(type/*: Arrow.type.Map_*/) {}
    }

    /******************************************************************************
     *
     * View
     *
     */

    /**
     * A View object represents a specific transform (configuration or pivot,
     * filter, sort, etc) configuration on an underlying {@link table}. A View
     * receives all updates from the {@link table} from which it is derived, and
     * can be serialized to JSON or trigger a callback when it is updated.  View
     * objects are immutable, and will remain in memory and actively process
     * updates until its {@link view#delete} method is called.
     *
     * <strong>Note</strong> This constructor is not public - Views are created
     * by invoking the {@link table#view} method.
     *
     * @example
     * // Returns a new View, pivoted in the row space by the "name" column.
     * table.view({row_pivots: ["name"]});
     *
     * @class
     * @hideconstructor
     */
    function view(pool, ctx, sides, gnode, config, name, callbacks, table) {
        this.ctx = ctx;
        this.nsides = sides;
        this.gnode = gnode;
        this.config = config || {};
        this.pool = pool;
        this.callbacks = callbacks;
        this.name = name;
        this.table = table;
    }

    /**
     * Delete this {@link view} and clean up all resources associated with it.
     * View objects do not stop consuming resources or processing updates when
     * they are garbage collected - you must call this method to reclaim these.
     */
    view.prototype.delete = async function() {
        this.pool.unregister_context(this.gnode.get_id(), this.name);
        this.ctx.delete();
        this.table.views.splice(this.table.views.indexOf(this), 1);
        this.table = undefined;
        let i = 0,
            j = 0;
        while (i < this.callbacks.length) {
            let val = this.callbacks[i];
            if (val.view !== this) this.callbacks[j++] = val;
            i++;
        }
        this.callbacks.length = j;
        if (this._delete_callback) {
            this._delete_callback();
        }
    };

    /**
     * How many pivoted sides does this view have?
     *
     * @private
     *
     * @returns {number} sides The number of sides of this `View`.
     */
    view.prototype.sides = function() {
        return this.nsides;
    };

    view.prototype._column_names = function() {
        let col_names = [];
        let aggs = this.ctx.get_column_names();
        for (let key = 0; key < this.ctx.unity_get_column_count(); key++) {
            let col_name;
            if (this.sides() === 0) {
                col_name = aggs.get(key);
                if (col_name === "psp_okey") {
                    continue;
                }
            } else {
                let name = aggs.get(key % aggs.size()).name();
                if (name === "psp_okey") {
                    continue;
                }
                let col_path = this.ctx.unity_get_column_path(key + 1);
                col_name = [];
                for (let cnix = 0; cnix < col_path.size(); cnix++) {
                    col_name.push(__MODULE__.scalar_vec_to_val(col_path, cnix));
                }
                col_name = col_name.reverse();
                col_name.push(name);
                col_name = col_name.join(COLUMN_SEPARATOR_STRING);
                col_path.delete();
            }
            col_names.push(col_name);
        }
        aggs.delete();
        return col_names;
    };

    /**
     * The schema of this {@link view}.  A schema is an Object, the keys of which
     * are the columns of this {@link view}, and the values are their string type names.
     * If this {@link view} is aggregated, theses will be the aggregated types;
     * otherwise these types will be the same as the columns in the underlying
     * {@link table}
     *
     * @async
     *
     * @returns {Promise<Object>} A Promise of this {@link view}'s schema.
     */
    view.prototype.schema = async function() {
        // get type mapping
        let schema = this.gnode.get_tblschema();
        let _types = schema.types();
        let names = schema.columns();
        schema.delete();

        let types = {};
        for (let i = 0; i < names.size(); i++) {
            types[names.get(i)] = _types.get(i).value;
        }
        let new_schema = {};
        let col_names = this._column_names();
        for (let col_name of col_names) {
            col_name = col_name.split(COLUMN_SEPARATOR_STRING);
            col_name = col_name[col_name.length - 1];
            if (types[col_name] === 1 || types[col_name] === 2) {
                new_schema[col_name] = "integer";
            } else if (types[col_name] === 19) {
                new_schema[col_name] = "string";
            } else if (types[col_name] === 9 || types[col_name] === 10) {
                new_schema[col_name] = "float";
            } else if (types[col_name] === 11) {
                new_schema[col_name] = "boolean";
            } else if (types[col_name] === 12) {
                new_schema[col_name] = "date";
            }
            if (this.sides() > 0 && this.config.row_pivot.length > 0) {
                new_schema[col_name] = map_aggregate_types(col_name, new_schema[col_name], this.config.aggregate);
            }
        }

        _types.delete();
        names.delete();

        return new_schema;
    };

    const map_aggregate_types = function(col_name, orig_type, aggregate) {
        const INTEGER_AGGS = ["distinct count", "distinctcount", "distinct", "count"];
        const FLOAT_AGGS = ["avg", "mean", "mean by count", "weighted_mean", "pct sum parent", "pct sum grand total"];

        for (let agg in aggregate) {
            let found_agg = aggregate[agg];
            if (found_agg.column.join(COLUMN_SEPARATOR_STRING) === col_name) {
                if (INTEGER_AGGS.includes(found_agg.op)) {
                    return "integer";
                } else if (FLOAT_AGGS.includes(found_agg.op)) {
                    return "float";
                }
            }
        }
        return orig_type;
    };

    const to_format = async function(options, formatter) {
        options = options || {};
        let viewport = this.config.viewport ? this.config.viewport : {};
        let start_row = options.start_row || (viewport.top ? viewport.top : 0);
        let end_row = options.end_row || (viewport.height ? start_row + viewport.height : this.ctx.get_row_count());
        let start_col = options.start_col || (viewport.left ? viewport.left : 0);
        let end_col = options.end_col || (viewport.width ? start_row + viewport.width : this.ctx.unity_get_column_count() + (this.sides() === 0 ? 0 : 1));
        let slice;
        if (this.config.row_pivot[0] === "psp_okey") {
            end_row += this.config.column_pivot.length;
        }
        if (this.sides() === 0) {
            slice = __MODULE__.get_data_zero(this.ctx, start_row, end_row, start_col, end_col);
        } else if (this.sides() === 1) {
            slice = __MODULE__.get_data_one(this.ctx, start_row, end_row, start_col, end_col);
        } else {
            slice = __MODULE__.get_data_two(this.ctx, start_row, end_row, start_col, end_col);
        }

        let data = formatter.initDataValue();

        let col_names = [[]].concat(this._column_names());
        let row;
        let ridx = -1;
        for (let idx = 0; idx < slice.length; idx++) {
            let cidx = idx % (end_col - start_col);
            if (cidx === 0) {
                if (row) {
                    formatter.addRow(data, row);
                }
                row = formatter.initRowValue();
                ridx++;
            }
            if (this.sides() === 0) {
                let col_name = col_names[start_col + cidx + 1];
                formatter.setColumnValue(data, row, col_name, slice[idx]);
            } else {
                if (cidx === 0) {
                    if (this.config.row_pivot[0] !== "psp_okey") {
                        let col_name = "__ROW_PATH__";
                        let row_path = this.ctx.unity_get_row_path(start_row + ridx);
                        formatter.initColumnValue(data, row, col_name);
                        for (let i = 0; i < row_path.size(); i++) {
                            const value = __MODULE__.scalar_vec_to_val(row_path, i);
                            formatter.addColumnValue(data, row, col_name, value);
                        }
                        row_path.delete();
                    }
                } else {
                    let col_name = col_names[start_col + cidx];
                    formatter.setColumnValue(data, row, col_name, slice[idx]);
                }
            }
        }

        if (row) {
            formatter.addRow(data, row);
        }
        if (this.config.row_pivot[0] === "psp_okey") {
            data = formatter.slice(data, this.config.column_pivot.length);
        }

        return formatter.formatData(data, options.config);
    };

    /**
     * Serializes this view to JSON data in a column-oriented format.
     *
     * @async
     *
     * @param {Object} [options] An optional configuration object.
     * @param {number} options.start_row The starting row index from which
     * to serialize.
     * @param {number} options.end_row The ending row index from which
     * to serialize.
     * @param {number} options.start_col The starting column index from which
     * to serialize.
     * @param {number} options.end_col The ending column index from which
     * to serialize.
     *
     * @returns {Promise<Array>} A Promise resolving to An array of Objects
     * representing the rows of this {@link view}.  If this {@link view} had a
     * "row_pivots" config parameter supplied when constructed, each row Object
     * will have a "__ROW_PATH__" key, whose value specifies this row's
     * aggregated path.  If this {@link view} had a "column_pivots" config
     * parameter supplied, the keys of this object will be comma-prepended with
     * their comma-separated column paths.
     */
    view.prototype.to_columns = async function(options) {
        return to_format.call(this, options, formatters.jsonTableFormatter);
    };

    /**
     * Serializes this view to JSON data in a row-oriented format.
     *
     * @async
     *
     * @param {Object} [options] An optional configuration object.
     * @param {number} options.start_row The starting row index from which
     * to serialize.
     * @param {number} options.end_row The ending row index from which
     * to serialize.
     * @param {number} options.start_col The starting column index from which
     * to serialize.
     * @param {number} options.end_col The ending column index from which
     * to serialize.
     *
     * @returns {Promise<Array>} A Promise resolving to An array of Objects
     * representing the rows of this {@link view}.  If this {@link view} had a
     * "row_pivots" config parameter supplied when constructed, each row Object
     * will have a "__ROW_PATH__" key, whose value specifies this row's
     * aggregated path.  If this {@link view} had a "column_pivots" config
     * parameter supplied, the keys of this object will be comma-prepended with
     * their comma-separated column paths.
     */
    view.prototype.to_json = async function(options) {
        return to_format.call(this, options, formatters.jsonFormatter);
    };

    /**
     * Serializes this view to CSV data in a standard format.
     *
     * @async
     *
     * @param {Object} [options] An optional configuration object.
     * @param {number} options.start_row The starting row index from which
     * to serialize.
     * @param {number} options.end_row The ending row index from which
     * to serialize.
     * @param {number} options.start_col The starting column index from which
     * to serialize.
     * @param {number} options.end_col The ending column index from which
     * to serialize.
     * @param {Object} options.config A config object for the Papaparse {@link https://www.papaparse.com/docs#json-to-csv}
     * config object.
     *
     * @returns {Promise<string>} A Promise resolving to a string in CSV format
     * representing the rows of this {@link view}.  If this {@link view} had a
     * "row_pivots" config parameter supplied when constructed, each row
     * will have prepended those values specified by this row's
     * aggregated path.  If this {@link view} had a "column_pivots" config
     * parameter supplied, the keys of this object will be comma-prepended with
     * their comma-separated column paths.
     */
    view.prototype.to_csv = async function(options) {
        return to_format.call(this, options, formatters.csvFormatter);
    };

    /**
     * The number of aggregated rows in this {@link view}.  This is affected by
     * the "row_pivots" configuration parameter supplied to this {@link view}'s
     * contructor.
     *
     * @async
     *
     * @returns {Promise<number>} The number of aggregated rows.
     */
    view.prototype.num_rows = async function() {
        return this.ctx.get_row_count();
    };

    /**
     * The number of aggregated columns in this {@link view}.  This is affected by
     * the "column_pivots" configuration parameter supplied to this {@link view}'s
     * contructor.
     *
     * @async
     *
     * @returns {Promise<number>} The number of aggregated columns.
     */
    view.prototype.num_columns = async function() {
        return this.ctx.unity_get_column_count();
    };

    /**
     * Whether this row at index `idx` is in an expanded or collapsed state.
     *
     * @async
     *
     * @returns {Promise<bool>} Whether this row is expanded.
     */
    view.prototype.get_row_expanded = async function(idx) {
        return this.ctx.unity_get_row_expanded(idx);
    };

    /**
     * Expands the row at index `idx`.
     *
     * @async
     *
     * @returns {Promise<void>}
     */
    view.prototype.expand = async function(idx) {
        if (this.nsides === 2 && this.ctx.unity_get_row_depth(idx) < this.config.row_pivot.length) {
            return this.ctx.open(__MODULE__.t_header.HEADER_ROW, idx);
        } else if (this.nsides < 2) {
            return this.ctx.open(idx);
        }
    };

    /**
     * Collapses the row at index `idx`.
     *
     * @async
     *
     * @returns {Promise<void>}
     */
    view.prototype.collapse = async function(idx) {
        if (this.nsides === 2) {
            return this.ctx.close(__MODULE__.t_header.HEADER_ROW, idx);
        } else {
            return this.ctx.close(idx);
        }
    };

    /**
     * Expand the tree down to `depth`.
     *
     */
    view.prototype.expand_to_depth = async function(depth) {
        if (this.config.row_pivot.length >= depth) {
            if (this.nsides === 2) {
                return this.ctx.expand_to_depth(__MODULE__.t_header.HEADER_ROW, depth);
            } else {
                return this.ctx.expand_to_depth(depth);
            }
        } else {
            console.warn(`Cannot expand past ${this.config.row_pivot.length}`);
        }
    };

    /**
     * Collapse the tree down to `depth`.
     *
     */
    view.prototype.collapse_to_depth = async function(depth) {
        if (this.config.row_pivot.length >= depth) {
            if (this.nsides === 2) {
                return this.ctx.collapse_to_depth(__MODULE__.t_header.HEADER_ROW, depth);
            } else {
                return this.ctx.collapse_to_depth(depth);
            }
        } else {
            console.warn(`Cannot collapse past ${this.config.row_pivot.length}`);
        }
    };

    /**
     * Register a callback with this {@link view}.  Whenever the {@link view}'s
     * underlying table emits an update, this callback will be invoked with the
     * aggregated row deltas.
     *
     * @param {function} callback A callback function invoked on update.  The
     * parameter to this callback shares a structure with the return type of
     * {@link view#to_json}.
     */
    view.prototype.on_update = function(callback) {
        this.callbacks.push({
            view: this,
            callback: () => {
                if (this.ctx.get_step_delta) {
                    let delta = this.ctx.get_step_delta(0, 2147483647);
                    if (delta.cells.size() === 0) {
                        this.to_json().then(callback);
                    } else {
                        let rows = {};
                        for (let x = 0; x < delta.cells.size(); x++) {
                            rows[delta.cells.get(x).row] = true;
                        }
                        rows = Object.keys(rows);
                        Promise.all(
                            rows.map(row =>
                                this.to_json({
                                    start_row: Number.parseInt(row),
                                    end_row: Number.parseInt(row) + 1
                                })
                            )
                        ).then(results => callback([].concat.apply([], results)));
                    }
                } else {
                    callback();
                }
            }
        });
    };

    /**
     * Register a callback with this {@link view}.  Whenever the {@link view}
     * is deleted, this callback will be invoked.
     *
     * @param {function} callback A callback function invoked on update.  The
     *     parameter to this callback shares a structure with the return type of
     *     {@link view#to_json}.
     */
    view.prototype.on_delete = function(callback) {
        this._delete_callback = callback;
    };

    view.prototype.col_to_typed_array = async function() {
        // TODO: implement name-to-index matching
        /* const schema = await this.schema();

        if (schema[col_name] !== "float" || schema[col_name] !== "integer") {
            return null;
        }
        */
        let arrs = [];

        if (this.sides() === 0) {
            for (let i = 0; i < 100; i++) {
                let ta = __MODULE__.col_to_typed_array_zero(this.ctx, i);
                if (ta !== undefined) {
                    arrs.push({
                        index: i,
                        data: ta
                    });
                }
            }
        } else if (this.sides() === 1) {
            for (let i = 0; i < 100; i++) {
                let ta = __MODULE__.col_to_typed_array_one(this.ctx, i);
                if (ta !== undefined) {
                    arrs.push({
                        index: i,
                        data: ta
                    });
                }
            }
        } else {
            for (let i = 0; i < 100; i++) {
                let ta = __MODULE__.col_to_typed_array_two(this.ctx, i);
                if (ta !== undefined) {
                    arrs.push({
                        index: i,
                        data: ta
                    });
                }
            }
        }

        return arrs;
    };

    /******************************************************************************
     *
     * Table
     *
     */

    /**
     * A Table object is the basic data container in Perspective.  Tables are
     * typed - they have an immutable set of column names, and a known type for
     * each.
     *
     * <strong>Note</strong> This constructor is not public - Tables are created
     * by invoking the {@link table} factory method, either on the perspective
     * module object, or an a {@link worker} instance.
     *
     * @class
     * @hideconstructor
     */
    function table(gnode, pool, index, computed, limit, limit_index) {
        this.gnode = gnode;
        this.pool = pool;
        this.name = Math.random() + "";
        this.initialized = false;
        this.index = index;
        this.pool.set_update_delegate(this);
        this.computed = computed || [];
        this.callbacks = [];
        this.views = [];
        this.limit = limit;
        this.limit_index = limit_index;
    }

    table.prototype._update_callback = function() {
        for (let e in this.callbacks) {
            this.callbacks[e].callback();
        }
    };

    table.prototype._calculate_computed = function(tbl, computed_defs) {
        // tbl is the pointer to the C++ t_table

        for (let i = 0; i < computed_defs.length; ++i) {
            let coldef = computed_defs[i];
            let name = coldef["column"];
            let func = coldef["func"];
            let inputs = coldef["inputs"];
            let type = coldef["type"] || "string";

            let dtype;
            switch (type) {
                case "integer":
                    dtype = __MODULE__.t_dtype.DTYPE_INT32;
                    break;
                case "float":
                    dtype = __MODULE__.t_dtype.DTYPE_FLOAT64;
                    break;
                case "boolean":
                    dtype = __MODULE__.t_dtype.DTYPE_BOOL;
                    break;
                case "date":
                    dtype = __MODULE__.t_dtype.DTYPE_TIME;
                    break;
                case "string":
                default:
                    dtype = __MODULE__.t_dtype.DTYPE_STR;
                    break;
            }

            __MODULE__.table_add_computed_column(tbl, name, dtype, func, inputs);
        }
    };

    /**
     * Delete this {@link table} and clean up all resources associated with it.
     * Table objects do not stop consuming resources or processing updates when
     * they are garbage collected - you must call this method to reclaim these.
     */
    table.prototype.delete = function() {
        if (this.views.length > 0) {
            throw "Table still has contexts - refusing to delete.";
        }
        this.pool.unregister_gnode(this.gnode.get_id());
        this.gnode.delete();
        this.pool.delete();
        if (this._delete_callback) {
            this._delete_callback();
        }
    };

    /**
     * Register a callback with this {@link table}.  Whenever the {@link view}
     * is deleted, this callback will be invoked.
     *
     * @param {function} callback A callback function invoked on update.  The
     *     parameter to this callback shares a structure with the return type of
     *     {@link table#to_json}.
     */
    table.prototype.on_delete = function(callback) {
        this._delete_callback = callback;
    };

    /**
     * The number of accumulated rows in this {@link table}.  This is affected by
     * the "index" configuration parameter supplied to this {@link view}'s
     * contructor - as rows will be overwritten when they share an idnex column.
     *
     * @async
     *
     * @returns {Promise<number>} The number of accumulated rows.
     */
    table.prototype.size = async function() {
        return this.gnode.get_table().size();
    };

    table.prototype._schema = function() {
        let schema = this.gnode.get_tblschema();
        let columns = schema.columns();
        let types = schema.types();
        let new_schema = {};
        for (let key = 0; key < columns.size(); key++) {
            if (columns.get(key) === "psp_okey") {
                continue;
            }
            new_schema[columns.get(key)] = get_column_type(types.get(key).value);
        }
        schema.delete();
        columns.delete();
        types.delete();
        return new_schema;
    };

    /**
     * The schema of this {@link table}.  A schema is an Object whose keys are the
     * columns of this {@link table}, and whose values are their string type names.
     *
     * @async
     *
     * @returns {Promise<Object>} A Promise of this {@link table}'s schema.
     */
    table.prototype.schema = async function() {
        return this._schema();
    };

    table.prototype._computed_schema = function() {
        let computed = this.computed;

        if (computed.length < 0) return {};

        let schema = this.gnode.get_tblschema();
        let columns = schema.columns();
        let types = schema.types();

        let computed_schema = {};

        for (let i = 0; i < computed.length; i++) {
            const column_name = computed[i].column;
            const column_type = computed[i].type;

            const column = {};

            column.type = column_type;
            column.input_columns = computed[i].inputs;
            column.input_type = computed[i].input_type;
            column.computation = computed[i].computation;

            computed_schema[column_name] = column;
        }

        schema.delete();
        columns.delete();
        types.delete();
        return computed_schema;
    };

    /**
     * The computed schema of this {@link table}. Returns a schema of only computed
     * columns added by the user, the keys of which are computed columns and the values an
     * Object containing the associated column_name, column_type, and computation.
     *
     * @async
     *
     * @returns {Promise<Object>} A Promise of this {@link table}'s computed schema.
     */
    table.prototype.computed_schema = async function() {
        return this._computed_schema();
    };

    /**
     * Create a new {@link view} from this table with a specified
     * configuration.
     *
     * @param {Object} [config] The configuration object for this {@link view}.
     * @param {Array<string>} [config.row_pivot] An array of column names
     * to use as {@link https://en.wikipedia.org/wiki/Pivot_table#Row_labels Row Pivots}.
     * @param {Array<string>} [config.column_pivot] An array of column names
     * to use as {@link https://en.wikipedia.org/wiki/Pivot_table#Column_labels Column Pivots}.
     * @param {Array<Object>} [config.aggregate] An Array of Aggregate configuration objects,
     * each of which should provide an "name" and "op" property, repsresnting the string
     * aggregation type and associated column name, respectively.  Aggregates not provided
     * will use their type defaults
     * @param {Array<Array<string>>} [config.filter] An Array of Filter configurations to
     * apply.  A filter configuration is an array of 3 elements:  A column name,
     * a supported filter comparison string (e.g. '===', '>'), and a value to compare.
     * @param {Array<string>} [config.sort] An Array of column names by which to sort.
     *
     * @example
     * var view = table.view({
     *      row_pivot: ['region'],
     *      aggregate: [{op: 'dominant', column:'region'}],
     *      filter: [['client', 'contains', 'fred']],
     *      sort: ['value']
     * });
     *
     * @returns {view} A new {@link view} object for the supplied configuration,
     * bound to this table
     */
    table.prototype.view = function(config) {
        config = {...config};

        const _string_to_filter_op = {
            "&": __MODULE__.t_filter_op.FILTER_OP_AND,
            "|": __MODULE__.t_filter_op.FILTER_OP_OR,
            "<": __MODULE__.t_filter_op.FILTER_OP_LT,
            ">": __MODULE__.t_filter_op.FILTER_OP_GT,
            "==": __MODULE__.t_filter_op.FILTER_OP_EQ,
            contains: __MODULE__.t_filter_op.FILTER_OP_CONTAINS,
            "<=": __MODULE__.t_filter_op.FILTER_OP_LTEQ,
            ">=": __MODULE__.t_filter_op.FILTER_OP_GTEQ,
            "!=": __MODULE__.t_filter_op.FILTER_OP_NE,
            "begins with": __MODULE__.t_filter_op.FILTER_OP_BEGINS_WITH,
            "ends with": __MODULE__.t_filter_op.FILTER_OP_ENDS_WITH,
            or: __MODULE__.t_filter_op.FILTER_OP_OR,
            in: __MODULE__.t_filter_op.FILTER_OP_IN,
            and: __MODULE__.t_filter_op.FILTER_OP_AND,
            "is nan": __MODULE__.t_filter_op.FILTER_OP_IS_NAN,
            "is not nan": __MODULE__.t_filter_op.FILTER_OP_IS_NOT_NAN
        };

        const _string_to_aggtype = {
            "distinct count": __MODULE__.t_aggtype.AGGTYPE_DISTINCT_COUNT,
            distinctcount: __MODULE__.t_aggtype.AGGTYPE_DISTINCT_COUNT,
            distinct: __MODULE__.t_aggtype.AGGTYPE_DISTINCT_COUNT,
            sum: __MODULE__.t_aggtype.AGGTYPE_SUM,
            mul: __MODULE__.t_aggtype.AGGTYPE_MUL,
            avg: __MODULE__.t_aggtype.AGGTYPE_MEAN,
            mean: __MODULE__.t_aggtype.AGGTYPE_MEAN,
            count: __MODULE__.t_aggtype.AGGTYPE_COUNT,
            "weighted mean": __MODULE__.t_aggtype.AGGTYPE_WEIGHTED_MEAN,
            unique: __MODULE__.t_aggtype.AGGTYPE_UNIQUE,
            any: __MODULE__.t_aggtype.AGGTYPE_ANY,
            median: __MODULE__.t_aggtype.AGGTYPE_MEDIAN,
            join: __MODULE__.t_aggtype.AGGTYPE_JOIN,
            div: __MODULE__.t_aggtype.AGGTYPE_SCALED_DIV,
            add: __MODULE__.t_aggtype.AGGTYPE_SCALED_ADD,
            dominant: __MODULE__.t_aggtype.AGGTYPE_DOMINANT,
            "first by index": __MODULE__.t_aggtype.AGGTYPE_FIRST,
            "last by index": __MODULE__.t_aggtype.AGGTYPE_LAST,
            and: __MODULE__.t_aggtype.AGGTYPE_AND,
            or: __MODULE__.t_aggtype.AGGTYPE_OR,
            last: __MODULE__.t_aggtype.AGGTYPE_LAST_VALUE,
            high: __MODULE__.t_aggtype.AGGTYPE_HIGH_WATER_MARK,
            low: __MODULE__.t_aggtype.AGGTYPE_LOW_WATER_MARK,
            "sum abs": __MODULE__.t_aggtype.AGGTYPE_SUM_ABS,
            "sum not null": __MODULE__.t_aggtype.AGGTYPE_SUM_NOT_NULL,
            "mean by count": __MODULE__.t_aggtype.AGGTYPE_MEAN_BY_COUNT,
            identity: __MODULE__.t_aggtype.AGGTYPE_IDENTITY,
            "distinct leaf": __MODULE__.t_aggtype.AGGTYPE_DISTINCT_LEAF,
            "pct sum parent": __MODULE__.t_aggtype.AGGTYPE_PCT_SUM_PARENT,
            "pct sum grand total": __MODULE__.t_aggtype.AGGTYPE_PCT_SUM_GRAND_TOTAL
        };

        let name = Math.random() + "";

        config.row_pivot = config.row_pivot || [];
        config.column_pivot = config.column_pivot || [];

        // Column only mode
        if (config.row_pivot.length === 0 && config.column_pivot.length > 0) {
            config.row_pivot = ["psp_okey"];
            config.column_only = true;
        }

        // Filters
        let filters = [];
        let filter_op = __MODULE__.t_filter_op.FILTER_OP_AND;

        if (config.filter) {
            let schema = this._schema();
            filters = config.filter.map(function(filter) {
                if (schema[filter[0]] === "date") {
                    return [filter[0], _string_to_filter_op[filter[1]], +new DateParser().parse(filter[2])];
                } else {
                    return [filter[0], _string_to_filter_op[filter[1]], filter[2]];
                }
            });
            if (config.filter_op) {
                filter_op = _string_to_filter_op[config.filter_op];
            }
        }

        // Sort
        let sort = [];
        if (config.sort) {
            sort = config.sort.map(x => {
                if (!Array.isArray(x)) {
                    return [config.aggregate.map(agg => agg.column).indexOf(x), 1];
                } else {
                    return [config.aggregate.map(agg => agg.column).indexOf(x[0]), SORT_ORDERS.indexOf(x[1])];
                }
            });
            if (config.column_pivot.length > 0 && config.row_pivot.length > 0) {
                config.sort = config.sort.filter(x => config.row_pivot.indexOf(x[0]) === -1);
            }
        }

        // Row Pivots
        let aggregates = [];
        if (typeof config.aggregate === "object") {
            for (let aidx = 0; aidx < config.aggregate.length; aidx++) {
                let agg = config.aggregate[aidx];
                let agg_op = _string_to_aggtype[agg.op];
                if (config.column_only) {
                    agg_op = __MODULE__.t_aggtype.AGGTYPE_ANY;
                    config.aggregate[aidx].op = "any";
                }
                if (typeof agg.column === "string") {
                    agg.column = [agg.column];
                } else {
                    let dep_length = agg.column.length;
                    if ((agg.op === "weighted mean" && dep_length != 2) || (agg.op !== "weighted mean" && dep_length != 1)) {
                        throw `'${agg.op}' has incorrect arity ('${dep_length}') for column dependencies.`;
                    }
                }
                aggregates.push([agg.name || agg.column.join(COLUMN_SEPARATOR_STRING), agg_op, agg.column]);
            }
        } else {
            let agg_op = __MODULE__.t_aggtype.AGGTYPE_DISTINCT_COUNT;
            if (config.column_only) {
                agg_op = __MODULE__.t_aggtype.AGGTYPE_ANY;
            }
            let schema = this.gnode.get_tblschema();
            let t_aggs = schema.columns();
            for (let aidx = 0; aidx < t_aggs.size(); aidx++) {
                let column = t_aggs.get(aidx);
                if (column !== "psp_okey") {
                    aggregates.push([column, agg_op, [column]]);
                }
            }
            schema.delete();
            t_aggs.delete();
        }

        let context;
        let sides = 0;
        if (config.row_pivot.length > 0 || config.column_pivot.length > 0) {
            if (config.column_pivot && config.column_pivot.length > 0) {
                config.row_pivot = config.row_pivot || [];
                context = __MODULE__.make_context_two(this.gnode, config.row_pivot, config.column_pivot, filter_op, filters, aggregates, []);
                sides = 2;
                this.pool.register_context(this.gnode.get_id(), name, __MODULE__.t_ctx_type.TWO_SIDED_CONTEXT, context.$$.ptr);

                if (config.row_pivot_depth !== undefined) {
                    context.expand_to_depth(__MODULE__.t_header.HEADER_ROW, config.row_pivot_depth - 1);
                } else {
                    context.expand_to_depth(__MODULE__.t_header.HEADER_ROW, config.row_pivot.length);
                }

                if (config.column_pivot_depth !== undefined) {
                    context.expand_to_depth(__MODULE__.t_header.HEADER_COLUMN, config.column_pivot_depth - 1);
                } else {
                    context.expand_to_depth(__MODULE__.t_header.HEADER_COLUMN, config.column_pivot.length);
                }

                const groups = context.unity_get_column_count() / aggregates.length;
                const new_sort = [];

                for (let z = 0; z < groups; z++) {
                    for (let s of sort) {
                        new_sort.push([s[0] + z * aggregates.length, s[1]]);
                    }
                }

                if (sort.length > 0) {
                    __MODULE__.sort(context, new_sort);
                }
            } else {
                context = __MODULE__.make_context_one(this.gnode, config.row_pivot, filter_op, filters, aggregates, sort);
                sides = 1;
                this.pool.register_context(this.gnode.get_id(), name, __MODULE__.t_ctx_type.ONE_SIDED_CONTEXT, context.$$.ptr);

                if (config.row_pivot_depth !== undefined) {
                    context.expand_to_depth(config.row_pivot_depth - 1);
                } else {
                    context.expand_to_depth(config.row_pivot.length);
                }
            }
        } else {
            context = __MODULE__.make_context_zero(
                this.gnode,
                filter_op,
                filters,
                aggregates.map(function(x) {
                    return x[0];
                }),
                sort
            );
            this.pool.register_context(this.gnode.get_id(), name, __MODULE__.t_ctx_type.ZERO_SIDED_CONTEXT, context.$$.ptr);
        }

        let v = new view(this.pool, context, sides, this.gnode, config, name, this.callbacks, this);
        this.views.push(v);
        return v;
    };

    /**
     * Updates the rows of a {@link table}.  Updated rows are pushed down to any
     * derived {@link view} objects.
     *
     * @param {Object<string, Array>|Array<Object>|string} data The input data
     * for this table.  The supported input types mirror the constructor options, minus
     * the ability to pass a schema (Object<string, string>) as this table has.
     * already been constructed, thus its types are set in stone.
     *
     * @see {@link table}
     */
    table.prototype.update = function(data) {
        let pdata;
        let cols = this._columns();
        let schema = this.gnode.get_tblschema();
        let types = schema.types();

        if (data instanceof ArrayBuffer) {
            pdata = load_arrow_buffer(data, cols, types);
        } else {
            pdata = parse_data(data, cols, types);
        }

        let tbl;
        try {
            tbl = __MODULE__.make_table(pdata.row_count || 0, pdata.names, pdata.types, pdata.cdata, this.limit_index, this.limit || 4294967295, this.index || "", pdata.is_arrow, false);

            this.limit_index += pdata.row_count;
            if (this.limit) {
                this.limit_index = this.limit_index % this.limit;
            }

            // Add any computed columns
            this._calculate_computed(tbl, this.computed);

            __MODULE__.fill(this.pool, this.gnode, tbl);
            this.initialized = true;
        } catch (e) {
            console.error(e);
        } finally {
            if (tbl) {
                tbl.delete();
            }
            schema.delete();
            types.delete();
        }
    };

    /**
     * Removes the rows of a {@link table}.  Removed rows are pushed down to any
     * derived {@link view} objects.
     *
     * @param {Array<Object>} data An array of primary keys to remove.
     *
     * @see {@link table}
     */
    table.prototype.remove = function(data) {
        let pdata;
        let schema = this.gnode.get_tblschema();
        let types = schema.types();
        schema.delete();

        data = data.map(idx => ({[this.index]: idx}));

        if (data instanceof ArrayBuffer) {
            pdata = load_arrow_buffer(data, [this.index], types);
        } else {
            pdata = parse_data(data, [this.index], types);
        }

        let tbl;
        try {
            tbl = __MODULE__.make_table(pdata.row_count || 0, pdata.names, pdata.types, pdata.cdata, this.limit_index, this.limit || 4294967295, this.index || "", pdata.is_arrow, true);

            this.limit_index += pdata.cdata.length;
            if (this.limit) {
                this.limit_index = this.limit_index % this.limit;
            }

            __MODULE__.fill(this.pool, this.gnode, tbl);
            this.initialized = true;
        } catch (e) {
            console.error(e);
        } finally {
            if (tbl) {
                tbl.delete();
            }
            types.delete();
        }
    };

    /**
     * Create a new table with the addition of new computed columns (defined as javascript functions)
     */
    table.prototype.add_computed = function(computed) {
        let pool, gnode, tbl;

        try {
            // Create perspective pool
            pool = new __MODULE__.t_pool({_update_callback: function() {}});

            // Pull out the t_table from the current gnode
            tbl = __MODULE__.clone_gnode_table(this.gnode);

            // Add new computed columns in place to tbl
            this._calculate_computed(tbl, computed);

            gnode = __MODULE__.make_gnode(tbl);
            pool.register_gnode(gnode);
            __MODULE__.fill(pool, gnode, tbl);

            // Merge in definition of previous computed columns
            if (this.computed.length > 0) {
                computed = this.computed.concat(computed);
            }

            return new table(gnode, pool, this.index, computed);
        } catch (e) {
            if (pool) {
                pool.delete();
            }
            if (gnode) {
                gnode.delete();
            }
            throw e;
        } finally {
            if (tbl) {
                tbl.delete();
            }
        }
    };

    table.prototype._columns = function() {
        let schema = this.gnode.get_tblschema();
        let cols = schema.columns();
        let names = [];
        for (let cidx = 0; cidx < cols.size(); cidx++) {
            let name = cols.get(cidx);
            if (name !== "psp_okey") {
                names.push(name);
            }
        }
        schema.delete();
        cols.delete();
        return names;
    };

    /**
     * The column names of this table.
     *
     * @async
     *
     * @returns {Array<string>} An array of column names for this table.
     */
    table.prototype.columns = async function() {
        return this._columns();
    };

    table.prototype._column_metadata = function() {
        let schema = this.gnode.get_tblschema();
        let computed_schema = this._computed_schema();
        let cols = schema.columns();
        let types = schema.types();

        let metadata = [];
        for (let cidx = 0; cidx < cols.size(); cidx++) {
            let name = cols.get(cidx);
            let meta = {};

            if (name === "psp_okey") {
                continue;
            }

            meta.name = name;
            meta.type = get_column_type(types.get(cidx).value);

            let computed_col = computed_schema[name];

            if (computed_col !== undefined) {
                meta.computed = {
                    input_columns: computed_col.input_columns,
                    input_type: computed_col.input_type,
                    computation: computed_col.computation
                };
            } else {
                meta.computed = undefined;
            }

            metadata.push(meta);
        }

        types.delete();
        cols.delete();
        schema.delete();

        return metadata;
    };

    /**
     * Column metadata for this table.
     *
     * If the column is computed, the `computed` property is an Object containing:
     *  - Array `input_columns`
     *  - String `input_type`
     *  - Object `computation`.
     *
     *  Otherwise, `computed` is `undefined`.
     *
     * @async
     *
     * @returns {Array<object>} An array of Objects containing metadata for each column.
     */
    table.prototype.column_metadata = function() {
        return this._column_metadata();
    };

    table.prototype.execute = function(f) {
        f(this);
    };

    /******************************************************************************
     *
     * Worker API
     *
     */

    function error_to_json(error) {
        const obj = {};
        Object.getOwnPropertyNames(error).forEach(key => {
            obj[key] = error[key];
        }, error);
        return obj;
    }

    class Host {
        constructor() {
            this._tables = {};
            this._views = {};
        }

        init(msg) {
            this.post(msg);
        }

        post() {
            throw new Error("post() not implemented!");
        }

        clear_views(client_id) {
            for (let key of Object.keys(this._views)) {
                if (this._views[key].client_id === client_id) {
                    try {
                        this._views[key].delete();
                    } catch (e) {
                        console.error(e);
                    }
                    delete this._views[key];
                }
            }
            console.debug(`GC ${Object.keys(this._views).length} views in memory`);
        }

        process(msg, client_id) {
            switch (msg.cmd) {
                case "init":
                    this.init(msg);
                    break;
                case "table":
                    this._tables[msg.name] = perspective.table(msg.args[0], msg.options);
                    break;
                case "add_computed":
                    let table = this._tables[msg.original];
                    let computed = msg.computed;
                    // rehydrate computed column functions
                    for (let i = 0; i < computed.length; ++i) {
                        let column = computed[i];
                        eval("column.func = " + column.func);
                    }
                    this._tables[msg.name] = table.add_computed(computed);
                    break;
                case "table_generate":
                    let g;
                    eval("g = " + msg.args);
                    g(function(tbl) {
                        this._tables[msg.name] = tbl;
                        this.post({
                            id: msg.id,
                            data: "created!"
                        });
                    });
                    break;
                case "table_execute":
                    let f;
                    eval("f = " + msg.f);
                    f(this._tables[msg.name]);
                    break;
                case "view":
                    this._views[msg.view_name] = this._tables[msg.table_name].view(msg.config);
                    this._views[msg.view_name].client_id = client_id;
                    break;
                case "table_method": {
                    let obj = this._tables[msg.name];
                    let result;

                    try {
                        if (msg.subscribe) {
                            obj[msg.method](e => {
                                this.post({
                                    id: msg.id,
                                    data: e
                                });
                            });
                        } else {
                            result = obj[msg.method].apply(obj, msg.args);
                            if (result && result.then) {
                                result
                                    .then(data => {
                                        if (data) {
                                            this.post({
                                                id: msg.id,
                                                data: data
                                            });
                                        }
                                    })
                                    .catch(error => {
                                        this.post({
                                            id: msg.id,
                                            error: error_to_json(error)
                                        });
                                    });
                            } else {
                                this.post({
                                    id: msg.id,
                                    data: result
                                });
                            }
                        }
                    } catch (e) {
                        this.post({
                            id: msg.id,
                            error: error_to_json(e)
                        });
                        return;
                    }

                    break;
                }
                case "view_method": {
                    let obj = this._views[msg.name];
                    if (!obj) {
                        this.post({
                            id: msg.id,
                            error: {message: "View is not initialized"}
                        });
                        return;
                    }
                    if (msg.subscribe) {
                        try {
                            obj[msg.method](e => {
                                this.post({
                                    id: msg.id,
                                    data: e
                                });
                            });
                        } catch (error) {
                            this.post({
                                id: msg.id,
                                error: error_to_json(error)
                            });
                        }
                    } else {
                        obj[msg.method]
                            .apply(obj, msg.args)
                            .then(result => {
                                if (msg.method === "delete") {
                                    delete this._views[msg.name];
                                }
                                this.post({
                                    id: msg.id,
                                    data: result
                                });
                            })
                            .catch(error => {
                                this.post({
                                    id: msg.id,
                                    error: error_to_json(error)
                                });
                            });
                    }
                    break;
                }
            }
        }
    }

    class WorkerHost extends Host {
        constructor() {
            super();
            self.addEventListener("message", e => this.process(e.data), false);
        }

        post(msg) {
            self.postMessage(msg);
        }

        init(msg) {
            if (typeof WebAssembly === "undefined") {
                console.log("Loading asm.js");
            } else {
                console.log("Loading wasm");
                if (msg.data) {
                    module = {};
                    module.wasmBinary = msg.data;
                    module.wasmJSMethod = "native-wasm";
                    __MODULE__ = __MODULE__(module);
                } else {
                    let wasmXHR = new XMLHttpRequest();
                    wasmXHR.open("GET", msg.path + "psp.async.wasm", true);
                    wasmXHR.responseType = "arraybuffer";
                    wasmXHR.onload = function() {
                        module = {};
                        module.wasmBinary = wasmXHR.response;
                        module.wasmJSMethod = "native-wasm";
                        __MODULE__ = __MODULE__(module);
                    };
                    wasmXHR.send(null);
                }
            }
        }
    }

    if (typeof self !== "undefined" && self.addEventListener) {
        new WorkerHost();
    }

    /******************************************************************************
     *
     * Perspective
     *
     */

    const perspective = {
        __module__: __MODULE__,

        Host: Host,

        TYPE_AGGREGATES: TYPE_AGGREGATES,

        TYPE_FILTERS: TYPE_FILTERS,

        AGGREGATE_DEFAULTS: AGGREGATE_DEFAULTS,

        FILTER_DEFAULTS: FILTER_DEFAULTS,

        SORT_ORDERS: SORT_ORDERS,

        worker: function() {},

        /**
         * A factory method for constructing {@link table}s.
         *
         * @example
         * // Creating a table directly from node
         * var table = perspective.table([{x: 1}, {x: 2}]);
         *
         * @example
         * // Creating a table from a Web Worker (instantiated via the worker() method).
         * var table = worker.table([{x: 1}, {x: 2}]);
         *
         * @param {Object<string, Array>|Object<string, string>|Array<Object>|string} data The input data
         *     for this table.  When supplied an Object with string values, an empty
         *     table is returned using this Object as a schema.  When an Object with
         *     Array values is supplied, a table is returned using this object's
         *     key/value pairs as name/columns respectively.  When an Array is supplied,
         *     a table is constructed using this Array's objects as rows.  When
         *     a string is supplied, the parameter as parsed as a CSV.
         * @param {Object} [options] An optional options dictionary.
         * @param {string} options.index The name of the column in the resulting
         *     table to treat as an index.  When updating this table, rows sharing an
         *     index of a new row will be overwritten. `index` is mutually exclusive
         *     to `limit`
         * @param {integer} options.limit The maximum number of rows that can be
         *     added to this table.  When exceeded, old rows will be overwritten in
         *     the order they were inserted.  `limit` is mutually exclusive to
         *     `index`.
         *
         * @returns {table} A new {@link table} object.
         */
        table: function(data, options) {
            options = options || {};
            options.index = options.index || "";
            let pdata,
                chunked = false;

            if (data instanceof ArrayBuffer || (Buffer && data instanceof Buffer)) {
                // Arrow data
                pdata = load_arrow_buffer(data);
            } else {
                if (typeof data === "string") {
                    if (data[0] === ",") {
                        data = "_" + data;
                    }
                    data = papaparse.parse(data.trim(), {dynamicTyping: true, header: true}).data;
                }
                pdata = parse_data(data);
                chunked = pdata.row_count > CHUNKED_THRESHOLD;
            }

            if (options.index && options.limit) {
                throw `Cannot specify both index '${options.index}' and limit '${options.limit}'.`;
            }

            if (options.index && pdata.names.indexOf(options.index) === -1) {
                throw `Specified index '${options.index}' does not exist in data.`;
            }

            let tbl,
                gnode,
                pool,
                pages,
                limit_index = 0;

            try {
                // Create perspective pool
                pool = new __MODULE__.t_pool({_update_callback: function() {}});

                if (chunked) {
                    pages = pdata.cdata.map(x => x.splice(0, CHUNKED_THRESHOLD));
                } else {
                    pages = pdata.cdata;
                }

                // Fill t_table with data
                tbl = __MODULE__.make_table(pages[0].length || 0, pdata.names, pdata.types, pages, 0, options.limit || 4294967295, options.index, pdata.is_arrow, false);
                limit_index = tbl.size();
                if (options.limit) {
                    limit_index = limit_index % options.limit;
                }

                gnode = __MODULE__.make_gnode(tbl);
                pool.register_gnode(gnode);
                __MODULE__.fill(pool, gnode, tbl);

                if (chunked) {
                    while (pdata.cdata[0].length > 0) {
                        tbl.delete();
                        pages = pdata.cdata.map(x => x.splice(0, CHUNKED_THRESHOLD));

                        tbl = __MODULE__.make_table(pages[0].length || 0, pdata.names, pdata.types, pages, limit_index, options.limit || 4294967295, options.index, pdata.is_arrow, false);

                        limit_index += pages[0].length;
                        if (options.limit) {
                            limit_index = limit_index % options.limit;
                        }

                        __MODULE__.fill(pool, gnode, tbl);
                    }
                }

                return new table(gnode, pool, options.index, undefined, options.limit, limit_index);
            } catch (e) {
                if (pool) {
                    pool.delete();
                }
                if (gnode) {
                    gnode.delete();
                }
                throw e;
            } finally {
                if (tbl) {
                    tbl.delete();
                }
            }
        }
    };
    return perspective;
};
