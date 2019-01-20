import {getIndexedDataKey, ensureShardNameIsInShardMap} from "./sharding";
import {getIndexWriter} from "./serializer";
import { isShardedIndex } from "../templateApi/heirarchy";

export const add = async (heirarchy, store, mappedRecord, indexKey, indexNode) => {
    const indexedDataKey = getIndexedDataKey(indexNode, indexKey, mappedRecord);
    (await getWriter(heirarchy, store, indexKey, indexedDataKey, indexNode))
        .addItem(mappedRecord);
    await swapTempFileIn(store, indexedDataKey);
}

export const remove = async (heirarchy, store, mappedRecord, indexKey, indexNode)  => {
    const indexedDataKey = getIndexedDataKey(indexNode, indexKey, mappedRecord);
    const writer = await getWriter(heirarchy, store, indexKey, indexedDataKey, indexNode);
    writer.removeItem(mappedRecord.key);
    await swapTempFileIn(store, indexedDataKey);
};

export const update = async (heirarchy, store, mappedRecord, indexKey, indexNode) => {
    const indexedDataKey = getIndexedDataKey(indexNode, indexKey, mappedRecord);
    (await getWriter(heirarchy, store, indexKey, indexedDataKey, indexNode))
            .updateItem(mappedRecord);
    await swapTempFileIn(store, indexedDataKey);
}

const getWriter = async (heirarchy, store, indexKey, indexedDataKey, indexNode) => {

    let readableStream = null;
    try {
        readableStream = await store.readableFileStream(indexedDataKey);
    } catch(e) {
        if(await store.exists(indexedDataKey)) {
            throw e;
        } else {
            await store.createFile(indexedDataKey, "");
            readableStream = await store.readableFileStream(indexedDataKey);
        }
    }

    if(isShardedIndex(indexNode)) {
        await ensureShardNameIsInShardMap(store, indexKey, indexedDataKey);
    }

    const writableStream = await store.writableFileStream(indexedDataKey + ".temp");
    
    return getIndexWriter(
        heirarchy, indexNode, 
        () => readableStream.read(),
        (buffer) => writableStream.write(buffer)
    );
};

const swapTempFileIn = async (store, indexedDataKey, isRetry=false) => {
    const tempFile = indexedDataKey + ".temp";
    try {
        await store.deleteFile(indexedDataKey);
    } catch(e) {
        // ignore failure, incase it has not been created yet
    }
    try {
        await store.renameFile(tempFile, indexedDataKey);
    } catch(e) {
        // retrying in case delete failure was for some other reason
        if(!isRetry) {
            await swapTempFileIn(store, indexedDataKey, true);
        }
    }
} ;