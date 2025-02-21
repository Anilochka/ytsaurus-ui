import React from 'react';
// @ts-ignore
import yt from '@ytsaurus/javascript-wrapper/lib/yt';

import {Toaster} from '@gravity-ui/uikit';
import Link from '../../../../components/Link/Link';

import {COPY_OBJECT} from '../../../../constants/navigation/modals/copy-object';
import {showErrorInModal} from '../../../../store/actions/navigation/modals/path-editing-popup';
import {HIDE_ERROR} from '../../../../constants/navigation/modals/path-editing-popup';
import {prepareDestinationPath, preparePath} from '../../../../utils/navigation';
import CancelHelper from '../../../../utils/cancel-helper';

import map_ from 'lodash/map';

import {executeBatchWithRetries} from '../../execute-batch';
import {YTApiId} from '../../../../rum/rum-wrap-api';
import {wrapBatchPromise} from '../../../../utils/utils';
import {Dispatch} from 'redux';

const requests = new CancelHelper();
const toaster = new Toaster();

interface CopyOptions {
    preserve_account?: boolean;
    recursive?: boolean;
}

function copyObjectIntoDirectory(from: string, to: string, options: CopyOptions) {
    const parts = from.split('/');
    const name = parts[parts.length - 1];
    return yt.v3.copy({
        parameters: {
            source_path: preparePath(from),
            destination_path: prepareDestinationPath(to, name),
            ...options,
        },
        cancellation: requests.saveCancelToken,
    });
}

function copyObjectWithRename(from: string, to: string, options: CopyOptions) {
    return yt.v3.copy({
        parameters: {
            source_path: preparePath(from),
            destination_path: to,
            ...options,
        },
        cancellation: requests.saveCancelToken,
    });
}

function copySingleObject(from: string, to: string, options: CopyOptions) {
    const lastChar = to.charAt(to.length - 1);

    if (lastChar === '/') {
        return copyObjectIntoDirectory(from, to, options);
    }

    return yt.v3
        .exists({parameters: {path: `${to}&`}, cancellation: requests.saveCancelToken})
        .then((exist: boolean) => {
            return exist
                ? copyObjectIntoDirectory(from, to, options)
                : copyObjectWithRename(from, to, options);
        });
}

function copyObjects(
    items: Array<{path: string; titleUnquoted: string}>,
    copyingPath: string,
    options: CopyOptions,
) {
    if (items.length === 1) {
        const [{path}] = items;
        return copySingleObject(path, copyingPath, options);
    }

    return yt.v3.startTransaction({timeout: 120000}).then((id: string) => {
        const copyRequests = map_(items, (node) => {
            return {
                command: 'copy' as const,
                parameters: {
                    transaction_id: id,
                    source_path: preparePath(node.path),
                    destination_path: prepareDestinationPath(copyingPath, node.titleUnquoted),
                    ...options,
                },
            };
        });

        return wrapBatchPromise(
            executeBatchWithRetries(YTApiId.navigationCopy, copyRequests, {
                errorTitle: 'Failed to copy the object(s)',
                saveCancelSourceCb: requests.saveCancelToken,
            }),
            'Failed to copy the object(s)',
        )
            .then(() => yt.v3.commitTransaction({transaction_id: id}))
            .catch((err) =>
                yt.v3.abortTransaction({transaction_id: id}).then(() => Promise.reject(err)),
            );
    });
}

export function copyObject(
    objectPath: string,
    copyingPath: string,
    onSuccess: () => void,
    multipleMode: boolean,
    items: Array<{path: string; titleUnquoted: string}>,
    options: CopyOptions,
) {
    return (dispatch: Dispatch) => {
        dispatch({type: COPY_OBJECT.REQUEST});

        return Promise.resolve()
            .then(() =>
                multipleMode
                    ? copyObjects(items, copyingPath, options)
                    : copySingleObject(objectPath, copyingPath, options),
            )
            .then(() => {
                dispatch({type: COPY_OBJECT.SUCCESS});

                if (typeof onSuccess === 'function') {
                    onSuccess();
                }

                toaster.add({
                    name: 'copy',
                    autoHiding: 10000,
                    theme: 'success',
                    title: multipleMode
                        ? 'Objects were successfully copied'
                        : 'Object was successfully copied',
                    content: <Link url={`navigation?path=${copyingPath}`}>{copyingPath}</Link>,
                });
            })
            .catch((error) => {
                if (error.code === yt.codes.CANCELLED) {
                    dispatch({
                        type: COPY_OBJECT.CANCELLED,
                    });
                } else {
                    dispatch({type: COPY_OBJECT.FAILURE});

                    const action = showErrorInModal(error);

                    dispatch(action);
                }
                return Promise.reject(error);
            });
    };
}

export function abortRequests() {
    return (dispatch: Dispatch) => {
        requests.removeAllRequests();

        dispatch({type: HIDE_ERROR});
    };
}
