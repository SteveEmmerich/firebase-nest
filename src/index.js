
//list data
export const FB_INIT_VAL = 'FB_INIT_VAL';
export const FB_CHILD_ADDED = 'FB_CHILD_ADDED';
export const FB_CHILD_WILL_REMOVE = 'FB_CHILD_WILL_REMOVE';
export const FB_CHILD_REMOVED = 'FB_CHILD_REMOVED';
export const FB_CHILD_WILL_CHANGE = 'FB_CHILD_WILL_CHANGE';
export const FB_CHILD_CHANGED = 'FB_CHILD_CHANGED';
//value data
export const FB_VALUE = 'FB_VALUE';

import importedAutoSubscriber from "./autoSubscriber";
export const autoSubscriber = importedAutoSubscriber;


//credit to js-promise-defer on github
function defer(deferred) {
    deferred.promise = new Promise(function (resolve, reject) {
        deferred.resolve = resolve;
        deferred.reject = reject;
    });
}


//Firebase 3.x: snapshot.key() has been replaced with snapshot.key
let getKey = function(snapshot) {
    if (typeof snapshot.key == 'function') {
        console.log("firebase-nest: detected pre-3.x firebase snapshot.key()");
        getKey = legacyGetKey;
        return legacyGetKey(snapshot);
    }
    console.log("firebase-nest: detected ^3.x firebase snapshot.key");
    getKey = newGetKey;
    return newGetKey(snapshot);
};
function legacyGetKey(snapshot) {
    return snapshot.key();
}
function newGetKey(snapshot) {
    return snapshot.key;
}

export default function createSubscriber({onData,
    onSubscribed,
    onUnsubscribed,
    resolveFirebaseQuery,
    onWillSubscribe,
    onWillUnsubscribe}) {

    var subscribedRegistry = {};
    var promisesBySubKey = {};

    const self = {
        loadedPromise,
        subscribeSubs
    };

    function loadedPromise(subKey) {
        if (promisesBySubKey[subKey]) {
            return promisesBySubKey[subKey].promise;
        }
        promisesBySubKey[subKey] = {};
        defer(promisesBySubKey[subKey]);
        return promisesBySubKey[subKey].promise;
    }

    if (!onData || !resolveFirebaseQuery) {
        console.error("createNestedFirebaseSubscriber: missing onData or resolveFirebaseQuery callback");
        return;
    }

    function subscribeToField(sub, forField, fieldKey, fieldVal, promises) {
        const store = (forField.store ? forField.store : self);
        var fieldSubs = forField.fieldSubs(fieldVal, ...(forField.args || [])) || [];
        subscribedRegistry[sub.subKey].fieldUnsubs[fieldKey] = store.subscribeSubs(fieldSubs);

        if (promises) {
            fieldSubs.forEach(fieldSub => promises.push(store.loadedPromise(fieldSub.subKey)));
        }
    }

    function subscribeToFields(sub, val, promises) {
        const oldFieldUnsubs = Object.assign({}, subscribedRegistry[sub.subKey].fieldUnsubs || {});

        subscribedRegistry[sub.subKey].fieldUnsubs = {};

        //Subscribe based on new fields in val
        const forFields = sub.forFields || [];
        if (forFields.constructor !== Array) {
            console.error("ERROR: forFields must be an array");
        } else {
            val = val || {};
            (forFields || []).forEach(forField => {
                if (!forField.fieldKey || !forField.fieldSubs) {
                    console.error("ERROR: each element in forFields must have fieldKey and fieldSubs keys");
                    return;
                }
                const fieldVal = val[forField.fieldKey];
                if (fieldVal !== undefined) {
                    subscribeToField(sub, forField, forField.fieldKey, fieldVal, promises);
                }
            })
        }

        //Unsubscribe old fields
        Object.keys(oldFieldUnsubs || {}).forEach(field => {
            const unsub = oldFieldUnsubs[field];
            unsub();
        });
    }

    function subscribeToChildData(sub, childKey, childVal, promises) {
        if (!sub.forEachChild) return;
        if (!sub.forEachChild.childSubs) {
            console.error("ERROR: forEachChild must have a childSubs key - a function that returns a subs array and takes a childKey and other optional args specifified in forEachChild.args")
        }
        const store = (sub.forEachChild.store ? sub.forEachChild.store : self);
        var childSubs = sub.forEachChild.childSubs(childKey, ...(sub.forEachChild.args||[]), childVal) || [];
        subscribedRegistry[sub.subKey].childUnsubs[childKey] = store.subscribeSubs(childSubs);

        if (promises) {
            childSubs.forEach(childSub => promises.push(store.loadedPromise(childSub.subKey)));
        }
    }

    function check(type, sub) {
        if (!subscribedRegistry[sub.subKey]) {
            console.error("Error on for "+sub.subKey+", got "+type+" firebase callback but not subscribed!");
            return false;
        }
        return true;
    }

    function executeListSubscribeAction(sub) {
        if (subscribedRegistry[sub.subKey]) {
            //Already subscribed, just increment ref count
            subscribedRegistry[sub.subKey].refCount++;
            return;
        }

        var ref = resolveFirebaseQuery(sub);
        var gotInitVal = false;
        subscribedRegistry[sub.subKey] = {
            refCount: 1,
            ref: ref,
            childUnsubs: {},
            fieldUnsubs: {},
            refHandles: {}
        };
        subscribedRegistry[sub.subKey].refHandles.child_added = ref.on('child_added', function(snapshot) {
            if (!gotInitVal) return;
            if (!check('child_added', sub)) return;
            subscribeToChildData(sub, getKey(snapshot), snapshot.val());
            onData(FB_CHILD_ADDED, snapshot, sub);
        });
        subscribedRegistry[sub.subKey].refHandles.child_changed = ref.on('child_changed', function(snapshot) {
            if (!gotInitVal) return;
            if (!check('child_changed', sub)) return;

            //Since we pass snapshot.val() to childSubs, it might use it, so we need call it when snapshot.val()
            //changes
            var childUnsub = subscribedRegistry[sub.subKey].childUnsubs[getKey(snapshot)];
            subscribeToChildData(sub, getKey(snapshot), snapshot.val());
            if (childUnsub) childUnsub();

            onData(FB_CHILD_WILL_CHANGE, snapshot, sub);
            onData(FB_CHILD_CHANGED, snapshot, sub);
        });
        subscribedRegistry[sub.subKey].refHandles.child_removed = ref.on('child_removed', function(snapshot) {
            if (!gotInitVal) return;
            if (!check('child_removed', sub)) return;
            const childUnsub = subscribedRegistry[sub.subKey].childUnsubs[getKey(snapshot)];
            delete subscribedRegistry[sub.subKey].childUnsubs[getKey(snapshot)];
            if (childUnsub) childUnsub();
            onData(FB_CHILD_WILL_REMOVE, snapshot, sub);
            onData(FB_CHILD_REMOVED, snapshot, sub);
        });
        ref.once('value', function(snapshot) {
            if (gotInitVal) {
                console.error("Got 'once' callback for "+getKey(snapshot)+" more than once");
                return;
            }
            gotInitVal = true;

            //We might've gotten unsubscribed while waiting for initial value, so check if we're still subscribed
            if (subscribedRegistry[sub.subKey]) {
                var val = snapshot.val();

                let nestedPromises = [];

                if (val !== null && (typeof val == 'object')) {
                    Object.keys(val).forEach(childKey=>subscribeToChildData(sub, childKey, val[childKey], nestedPromises));
                    subscribeToFields(sub, val, nestedPromises);
                }

                onData(FB_INIT_VAL, snapshot, sub);

                loadedPromise(sub.subKey);

                //Once all initial child & field promises are resolved, we can resolve ourselves
                Promise.all(nestedPromises).then(() => {
                    promisesBySubKey[sub.subKey].resolve(true)
                });
            }
        });
    }

    function executeValueSubscribeAction(sub) {
        if (subscribedRegistry[sub.subKey]) {
            //Already subscribed, just increment ref count
            subscribedRegistry[sub.subKey].refCount++;
            return;
        }

        var ref = resolveFirebaseQuery(sub);

        subscribedRegistry[sub.subKey] = {
            refCount: 1,
            ref: ref,
            childUnsubs: {},
            fieldUnsubs: {},
            refHandles: {}
        };

        let resolved = false;

        subscribedRegistry[sub.subKey].refHandles.value = ref.on('value', function(snapshot) {
            if (!check('value', sub)) return;

            //First subscribe to new value's nodes, then unsubscribe old ones - the ones in both old/new will remain
            //subscribed to firebase to avoid possibly blowing away firebase cache
            const oldChildUnsubs = Object.assign({}, subscribedRegistry[sub.subKey].childUnsubs);
            subscribedRegistry[sub.subKey].childUnsubs = {};

            const nestedPromises = (resolved ? null : []);

            var val = snapshot.val();
            if (val !== null && (typeof val == 'object')) {
                Object.keys(val).forEach(childKey=>subscribeToChildData(sub, childKey, val[childKey], nestedPromises));
                subscribeToFields(sub, val, nestedPromises);
            }
            Object.keys(oldChildUnsubs || {}).forEach(childKey=>{
                const childUnsub = oldChildUnsubs[childKey];
                childUnsub();
            });

            onData(FB_VALUE, snapshot, sub);

            if (!resolved) {
                resolved = true;
                loadedPromise(sub.subKey);

                Promise.all(nestedPromises).then(() => {
                    promisesBySubKey[sub.subKey].resolve(true)
                });
            }
        });
    }

    function unsubscribeSubKey(subKey) {
        var info = subscribedRegistry[subKey];
        if (!info) {
            console.error("no subscriber found for subKey=" + subKey);
        } else {
            if (onWillUnsubscribe) onWillUnsubscribe(subKey);
            info.refCount--;
            if (info.refCount == 0) {
                delete subscribedRegistry[subKey];
                delete promisesBySubKey[subKey];
                Object.keys(info.refHandles).forEach(eventType=> {
                    info.ref.off(eventType, info.refHandles[eventType]);
                });
                Object.keys(info.childUnsubs || {}).forEach(childKey=> {
                    const childUnsub = info.childUnsubs[childKey];
                    childUnsub();
                });
                Object.keys(info.fieldUnsubs || {}).forEach(fieldKey=> {
                    const fieldUnsub = info.fieldUnsubs[fieldKey];
                    fieldUnsub();
                });
            }
        }
        if (onUnsubscribed) onUnsubscribed(subKey);
    }

    function subscribeSub(sub) {
        if (!sub.subKey) {
            console.error("subscribeSub needs an object with a string subKey field");
            console.error(sub);
            return;
        }
        if (!sub.asList && !sub.asValue) {
            console.error("subscribeSub needs an object with either asList=true or asValue=true");
            console.error(sub);
            return;
        }

        if (onWillSubscribe) onWillSubscribe(sub);

        if (sub.asList) {
            executeListSubscribeAction(sub);
        } else if (sub.asValue) {
            executeValueSubscribeAction(sub);
        } else {
            console.error("sub must have asList or asValue = true");
        }

        if (onSubscribed) onSubscribed(sub);

        return function unsubscribe() {
            unsubscribeSubKey(sub.subKey);
        }
    }
    function subscribeSubs(subs) {
        if (!subs) return;
        if (!subs.forEach) {
            console.error("subscribeSubs expects an array of subs");
            console.error(subs);
            return;
        }
        var unsubs = subs.map(sub=>subscribeSub(sub));

        return function unsubscribe() {
            unsubs.forEach(unsub=>unsub());
        }
    }

    function unsubscribeAll() {
        while (Object.keys(subscribedRegistry || {}).length > 0) {
            unsubscribeSubKey(Object.keys(subscribedRegistry)[0])
        }
    }
    return { subscribeSubs, subscribedRegistry, unsubscribeAll, loadedPromise };
};

