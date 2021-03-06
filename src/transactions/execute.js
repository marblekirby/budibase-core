import {getRelevantAncestorIndexes,
    getRelevantReverseReferenceIndexes} from "../indexing/relevant";
import {evaluate} from "../indexing/evaluate";
import {$$, $, isSomething, 
        isNonEmptyArray, joinKey, 
        isNonEmptyString} from "../common";
import {filter, map, isUndefined, includes,
        flatten, intersectionBy,
        isEqual, pull, keys, 
        differenceBy, difference} from "lodash/fp";
import {union} from "lodash";
import {getIndexedDataKey} from "../indexing/sharding";
import {isUpdate, isCreate, 
        isDelete, isBuildIndex} from "./transactionsCommon";
import { applyToShard } from "../indexing/apply";
import {getActualKeyOfParent,
        isGlobalIndex, fieldReversesReferenceToIndex, isReferenceIndex,
        getExactNodeForPath} from "../templateApi/heirarchy";

export const executeTransactions =  app => async transactions => {
    const recordsByShard = mappedRecordsByIndexShard(app.heirarchy, transactions);         

    for(let shard of keys(recordsByShard)) {
        await applyToShard(
            app.heirarchy, app.datastore,
            recordsByShard[shard].indexKey,
            recordsByShard[shard].indexNode,
            shard,
            recordsByShard[shard].writes,
            recordsByShard[shard].removes
        )
    }
}

const mappedRecordsByIndexShard = (heirarchy, transactions) => {

    const updates = getUpdateTransactionsByShard(
        heirarchy, transactions
    );

    const created = getCreateTransactionsByShard(
        heirarchy, transactions
    );
    const deletes = getDeleteTransactionsByShard(
        heirarchy, transactions
    );

    const indexBuild = getBuildIndexTransactionsByShard(
        heirarchy,
        transactions
    );
    
    const toRemove = [
        ...deletes,
        ...updates.toRemove
    ];

    const toWrite = [
        ...created,
        ...updates.toWrite,
        ...indexBuild
    ];

    const transByShard = {};

    const initialiseShard = t => {
        if(isUndefined(transByShard[t.indexShardKey]))
            transByShard[t.indexShardKey] = {
                writes:[], 
                removes:[],
                indexKey:t.indexKey,
                indexNodeKey:t.indexNodeKey,
                indexNode:t.indexNode
            };
    }

    for(let trans of toWrite) {
        initialiseShard(trans);        
        transByShard[trans.indexShardKey].writes.push(
            trans.mappedRecord.result);
    }

    for(let trans of toRemove) {
        initialiseShard(trans);        
        transByShard[trans.indexShardKey].removes.push(
            trans.mappedRecord.result.key);
    }

    return transByShard;
}  

const getUpdateTransactionsByShard = (heirarchy, transactions) => {
    const updateTransactions = $(transactions, [filter(isUpdate)]);

    const evaluateIndex = (record, indexNodeAndPath) => {
        const mappedRecord = evaluate(record)(indexNodeAndPath.indexNode);
        return ({mappedRecord:mappedRecord, 
        indexNode:indexNodeAndPath.indexNode, 
        indexKey:indexNodeAndPath.indexKey,
        indexShardKey:getIndexedDataKey(
            indexNodeAndPath.indexNode,
            indexNodeAndPath.indexKey,
            mappedRecord.result)
        });
    }

    const getIndexNodesToApply = (indexFilter) => (t,indexes) => 
        $(indexes, [
            map(n => ({
                old:evaluateIndex(t.oldRecord, n),
                new:evaluateIndex(t.record, n)})),
            filter(indexFilter)
        ]);

    const toRemoveFilter = (n, isUnreferenced) => 
        n.old.mappedRecord.passedFilter === true
        && (n.new.mappedRecord.passedFilter === false
            || isUnreferenced);

    const toAddFilter = (n, isNewlyReferenced) => 
        (n.old.mappedRecord.passedFilter === false
        || isNewlyReferenced)
        && n.new.mappedRecord.passedFilter === true;

    const toUpdateFilter = n => 
        n.new.mappedRecord.passedFilter === true
        && n.old.mappedRecord.passedFilter === true
        && !isEqual(n.old.mappedRecord.result, 
                    n.new.mappedRecord.result);

    const toRemove = [];
    const toWrite = [];

    for(let t of updateTransactions) {
        const ancestorIdxs = getRelevantAncestorIndexes(
            heirarchy, t.record);

        const referenceChanges = diffReverseRefForUpdate(
            heirarchy, t.oldRecord, t.record);

        // old records to remove (filtered out)
        const filteredOut_toRemove =
            union(
                getIndexNodesToApply(toRemoveFilter)(t, ancestorIdxs),
                // still referenced - check filter
                getIndexNodesToApply(toRemoveFilter)(t, referenceChanges.notChanged),
                // un referenced - remove if in there already
                getIndexNodesToApply(n => toRemoveFilter(n,true))
                                    (t, referenceChanges.unReferenced)
            );

        // new records to add (filtered in)
        const filteredIn_toAdd =
            union(
                getIndexNodesToApply(toAddFilter)(t, ancestorIdxs),
                // newly referenced - check filter
                getIndexNodesToApply(n => toAddFilter(n,true))
                                    (t, referenceChanges.newlyReferenced),
                // reference unchanged - rerun filter in case something else changed
                getIndexNodesToApply(toAddFilter)(t, referenceChanges.notChanged),
            );

        const changed = 
            union(
                getIndexNodesToApply(toUpdateFilter)(t, ancestorIdxs),
                // still referenced - recheck filter
                getIndexNodesToApply(toUpdateFilter)(t, referenceChanges.notChanged),
            );
        
        const shardKeyChanged = $(changed,[
            filter(c => c.old.indexShardKey !== c.new.indexShardKey)
        ]);

        const changedInSameShard = $(shardKeyChanged, [
            difference(changed)
        ])

        for(let res of shardKeyChanged) {
            pull(res)(changed);
            filteredOut_toRemove.push(res);
            filteredIn_toAdd.push(res);
        }

        toRemove.push(
            $(filteredOut_toRemove,[
                map(i => i.old)
            ])
        );

        toWrite.push(
            $(filteredIn_toAdd, [
                map(i => i.new)
            ])
        );

        toWrite.push(
            $(changedInSameShard, [
                map(i => i.new)
            ])
        );
    }

    return ({
        toRemove: flatten(toRemove),
        toWrite: flatten(toWrite)
    });
    
};

const getBuildIndexTransactionsByShard =  (heirarchy, transactions) => {
    const buildTransactions = $(transactions, [filter(isBuildIndex)]);
    if(!isNonEmptyArray(buildTransactions)) return [];
    const indexNode = transactions.indexNode;

    const getIndexKeys = (t) => {
        if(isGlobalIndex(indexNode)) {
            return [indexNode.nodeKey()];
        } 

        if(isReferenceIndex(indexNode)) {
            const recordNode = getExactNodeForPath
                                    (heirarchy)
                                    (t.record.key);
            const refFields = $(recordNode.fields, [
                filter(fieldReversesReferenceToIndex(indexNode))
            ])
            const indexKeys = [];
            for(let refField of refFields) {
                const refValue = t.record[refField.name];
                if(isSomething(refValue) 
                   && isNonEmptyString(refValue.key)) {
                    const indexKey = joinKey(
                        refValue.key,
                        indexNode.name
                    );

                    if(!includes(indexKey)(indexKeys))
                        indexKeys.push(indexKey);
                }
            }
            return indexKeys;
        }

        return [joinKey(
            getActualKeyOfParent(
                indexNode.parent().nodeKey(),
                t.record.key
            ),
            indexNode.name
        )];
    }

    return $(buildTransactions, [
        map(t => {
            const mappedRecord = evaluate(t.record)(indexNode);
            if(!mappedRecord.passedFilter) return null;
            const indexKeys = getIndexKeys(t);
            return $(indexKeys, [
                map(indexKey => ({mappedRecord, 
                indexNode:indexNode, 
                indexKey:indexKey,
                indexShardKey:getIndexedDataKey(
                    indexNode,
                    indexKey,
                    mappedRecord.result)
                }))
            ]);
        }),
        flatten,
        filter(isSomething)
    ]);
}

const get_Create_Delete_TransactionsByShard = pred => (heirarchy, transactions) => {
    const createTransactions = $(transactions, [filter(pred)]);

    const getIndexNodesToApply = (t,indexes) => 
        $(indexes, [
            map(n => { 
                const mappedRecord = evaluate(t.record)(n.indexNode);
                return ({mappedRecord, 
                        indexNode:n.indexNode, 
                        indexKey:n.indexKey,
                        indexShardKey:getIndexedDataKey(
                            n.indexNode,
                            n.indexKey,
                            mappedRecord.result)
                    });
                }),
            filter(n => n.mappedRecord.passedFilter)
        ]);

    const allToApply = [];

    for(let t of createTransactions) {
        const ancestorIdxs = 
            getRelevantAncestorIndexes(heirarchy, t.record);
        const reverseRef = 
            getRelevantReverseReferenceIndexes(heirarchy, t.record);
        
        allToApply.push(
            getIndexNodesToApply(t, ancestorIdxs)
        );
        allToApply.push(
            getIndexNodesToApply(t, reverseRef)
        );
    }

    return flatten(allToApply);
}

const getDeleteTransactionsByShard = 
    get_Create_Delete_TransactionsByShard(isDelete);

const getCreateTransactionsByShard = 
    get_Create_Delete_TransactionsByShard(isCreate);

const diffReverseRefForUpdate = (appHeirarchy, oldRecord, newRecord) => {
    const oldIndexes = getRelevantReverseReferenceIndexes(
        appHeirarchy, oldRecord
    );
    const newIndexes = getRelevantReverseReferenceIndexes(
        appHeirarchy, newRecord
    );

    const unReferenced = differenceBy(
        i => i.indexKey,
        oldIndexes, newIndexes
    );

    const newlyReferenced = differenceBy(
        i => i.indexKey,
        newIndexes, oldIndexes
    );

    const notChanged =  intersectionBy(
        i => i.indexKey,
        newIndexes, oldIndexes
    );

    return  {
        unReferenced,
        newlyReferenced,
        notChanged
    };
}


