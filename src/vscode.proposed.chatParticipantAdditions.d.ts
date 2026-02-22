/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

    export class ChatResponseTextEditPart {
        uri: Uri;
        edits: TextEdit[];
        isDone?: boolean;
        constructor(uri: Uri, done: true);
        constructor(uri: Uri, edits: TextEdit | TextEdit[]);
    }

    // Extend the ChatResponsePart union to include ChatResponseTextEditPart
    export type ChatResponsePart2 =
        | ChatResponseMarkdownPart
        | ChatResponseFileTreePart
        | ChatResponseAnchorPart
        | ChatResponseProgressPart
        | ChatResponseReferencePart
        | ChatResponseCommandButtonPart
        | ChatResponseTextEditPart;

    export interface ChatResponseStream {
        push(part: ChatResponseTextEditPart): void;
    }
}
