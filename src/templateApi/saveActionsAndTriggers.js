import {appDefinitionFile} from "../common";
import {join} from "lodash";
import {map} from "lodash/fp";
import {validateTriggers, validateActions} from "./validate";
import {apiWrapper} from "../common/apiWrapper";
import {events} from "../common/events";
import {permission} from "../authApi/permissions";

export const saveActionsAndTriggers = app => async (actions, triggers) => 
    apiWrapper(
        app,  
        events.templateApi.saveActionsAndTriggers,
        permission.writeTemplates.isAuthorized,
        {actions, triggers},
        _saveActionsAndTriggers, app.datastore, actions, triggers
    );

export const _saveActionsAndTriggers = async (datastore, actions, triggers) => {
    if(await datastore.exists(appDefinitionFile)){
        const appDefinition = await datastore.loadJson(appDefinitionFile);
        appDefinition.actions = actions;
        appDefinition.triggers = triggers;

        const actionValidErrs = map(e => e.error)
                                (validateActions(actions));
        
        if(actionValidErrs.length > 0) {
            throw new Error("Actions are in valid: " + join(actionValidErrs,", "));
        }

        const triggerValidErrs = map(e => e.error)
                                (validateTriggers(triggers, actions));
        
        if(triggerValidErrs.length > 0) {
            throw new Error("Triggers are in valid: " + join(triggerValidErrs,", "));
        }

        await datastore.updateJson(appDefinitionFile, appDefinition);
    }
    else {
        throw new Error("Cannot save actions: Application definition does not exist");
    }
}