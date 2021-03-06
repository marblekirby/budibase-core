import {safeKey, apiWrapper, isSomething, 
    events, joinKey, $} from "../common";
import {_load, getRecordFileName} from "./load";
import {_deleteCollection} from "../collectionApi/delete";
import {getExactNodeForPath, 
        getFlattenedHierarchy, getNode,
        fieldReversesReferenceToNode} from "../templateApi/heirarchy";
import {map, flatten, filter} from "lodash/fp";
import {_deleteIndex} from "../indexApi/delete";
import {transactionForDeleteRecord} from "../transactions/create";
import {removeFromAllIds} from "../indexing/allIds";
import {permission} from "../authApi/permissions";

export const deleteRecord = (app, disableCleanup=false) => async (key) => 
    apiWrapper(
        app,
        events.recordApi.delete, 
        permission.deleteRecord.isAuthorized(key),
        {key},
        _deleteRecord, app, key, disableCleanup);

// called deleteRecord because delete is a keyword
export const _deleteRecord = async (app, key, disableCleanup) => { 
    key = safeKey(key);
    const node = getExactNodeForPath(app.heirarchy)(key);
    
    const record = await _load(app, key);
    await transactionForDeleteRecord(app, record);

    
    for(let collectionRecord of node.children) {
        const collectionKey = joinKey(
            key, collectionRecord.collectionName
        );
        await _deleteCollection(app, collectionKey, true);
    }

    
    await app.datastore.deleteFile(
        getRecordFileName(key));

    await deleteFiles(app, key);

    await removeFromAllIds(app.heirarchy, app.datastore)(record);
    
    if(!disableCleanup)
        await app.cleanupTransactions();
        
    await app.datastore.deleteFolder(key);
    await deleteIndexes(app, key)
};

const deleteIndexes = async (app, key) => {
    const node = getExactNodeForPath(app.heirarchy)
                                    (key);
    /*const reverseIndexKeys = $(app.heirarchy, [
        getFlattenedHierarchy,
        map(n => n.fields),
        flatten,
        filter(isSomething),
        filter(fieldReversesReferenceToNode(node)),
        map(f => $(f.typeOptions.reverseIndexNodeKeys, [
                    map(n => getNode(
                                app.heirarchy,
                                n))
                ])
        ),
        flatten,
        map(n => joinKey(key, n.name))
    ]);

    for(let i of reverseIndexKeys) {
        await _deleteIndex(app, i, true);
    }*/

    for(let index of node.indexes) {
        const indexKey = joinKey(key, index.name);
        await _deleteIndex(app, indexKey, true);
    }
}

const deleteFiles = async (app, key) => {
    
    const filesFolder = joinKey(key, "files");
    const allFiles = await app.datastore.getFolderContents(
        filesFolder
    );

    for(let file of allFiles) {
        await app.datastore.deleteFile(file);
    }
    
    await app.datastore.deleteFolder(
        joinKey(key, "files")
    );
}