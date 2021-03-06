import {assign, keys, merge, has} from "lodash";
import { map, isString, isNumber, 
        isBoolean, isDate, 
        isObject, isArray} from "lodash/fp";
import {$} from "../common";
import {parsedSuccess} from "./typeHelpers";
import string from "./string";
import bool from "./bool";
import number from "./number";
import datetime from "./datetime";
import array from "./array";
import reference from "./reference";
import file from "./file";

const allTypes = () => {
    const basicTypes = {
        string, number, datetime, bool, reference, file
    };        

    const arrays = $(basicTypes, [
        keys,
        map(k => {
            const kvType = {};
            const concreteArray = array(basicTypes[k]);
            kvType[concreteArray.name] = concreteArray;
            return kvType;
        }),
        types => assign({}, ...types) 
    ]);
    
    return merge({}, basicTypes, arrays);
}; 


export const all = allTypes();

export const getType = typeName =>  {
    if(!has(all, typeName)) throw new Error("Do not recognise type " + typeName);
    return all[typeName];
};

export const getSampleFieldValue = field =>
    getType(field.type).sampleValue;

export const getNewFieldValue = field => 
    getType(field.type).getNew(field);

export const safeParseField = (field, record) => 
    getType(field.type).safeParseField(field, record);

export const validateFieldParse = (field, record) => 
    has(record, field.name) 
    ? getType(field.type).tryParse(record[field.name])
    : parsedSuccess(undefined); // fields may be undefined by default

export const getDefaultOptions = type => 
    getType(type).getDefaultOptions();

export const validateTypeConstraints = async (field, record, context) => 
    await getType(field.type).validateTypeConstraints(field, record, context);

export const detectType = value => {
    if(isString(value)) return string;
    if(isBoolean(value)) return bool;
    if(isNumber(value)) return number;
    if(isDate(value)) return datetime;
    if(isArray(value)) return array(detectType(value[0]));
    if(isObject(value) 
       && has(value, "key")
       && has(value, "value")) return reference;
    if(isObject(value)
        && has(value, "relativePath")
        && has(value, "size")) return file;
    
    throw new Error("cannot determine type: " + JSON.stringify(value));
}