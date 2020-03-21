import fs from "fs";
import Bluebird from "bluebird";

import MongoDBModels from "../database/models.js"
import {  FileMetadata} from "../database/files_collection.js";
import { ChunkifyReadStream } from "./utils/chunkify.js";
import { AccountManager } from "../google/accounts.js";
import { generateAccounts } from "../google/utils/helper.js";
import Media from "../utils/media.js";
import {parseOptions} from "../utils/helper.js";
import AwaitLock from 'await-lock';
import GoogleCredentialsConfig from "../configs/googlecredentials.js";


const lock  = new AwaitLock();



const chunkifyUpload_OPTIONS_TEMPLATE = {
    "fileType": "",
    "chunkSize": 0
}

const uploadChunkifiedFile_OPTIONS_TEMPLATE = {
    "fileType": "",
}

var SINGLETONS = {

}

export class FileUploader {
    constructor(loginURI=null, db="hls") {
        if(SINGLETONS[loginURI+"_"+db])
            return SINGLETONS[loginURI+"_"+db];

        this._loginURI = loginURI;
        this._db = db;
        this.models = new MongoDBModels(loginURI, db);
        this.filesCollection = this.models.filesCollection;
        this.chunksCollection = this.models.chunksCollection;
        this.accountManager = null;
        SINGLETONS[loginURI+"_"+db] = this;
        return this;
    }

    async assertAccountManager() {
        await lock.acquireAsync();
        // if no accountManager is preloaded, then we will create one by default
        if(!this.accountManager) {
            this.accountManager = new AccountManager();
        }

        //load default accounts
        if(!Object.keys(this.accountManager.accounts).length)  {
            let accounts = await generateAccounts(GoogleCredentialsConfig.service_accounts).catch(e => console.log(e));
            if(!accounts || !accounts.length)
                throw "Failed to load accounts";

            accounts.forEach((account) => {
                this.accountManager.addAccount(account);
            });
        }
        lock.release();
    }

    loadAccountManager(accountManager) {
        this.accountManager = accountManager;
    }

    async getGoogleDriveFile(googleFileId) {
        await this.assertAccountManager();

        let selectedAccount =  await this.accountManager.getMostAvailableStorageAccount();
        if(!selectedAccount) {
            console.log("No available accounts!")
            return null;
        }

        return await selectedAccount.getFile(googleFileId).catch(e => console.log(e));

    }

    async close() {
        delete SINGLETONS[this._loginURI+"_"+this._db];
        await this.models.close()
    }

    async uploadChunkifiedFile(chunkStreams, options) {
        await this.assertAccountManager();

        options = parseOptions(options, uploadChunkifiedFile_OPTIONS_TEMPLATE);
        if(!chunkStreams.length)
            return null;

        let chunkIds = new Array(chunkStreams.length);

        try {
            await Bluebird.mapSeries(chunkStreams, async (chunkStream, index) => {
                let chunk = await this.uploadChunk(chunkStream, {fileType: options.fileType});
                // better error handling here
                if(!chunk) 
                    throw "error";

                chunkIds[index] = chunk._id;
            });
        } catch(e) {
            console.log(e);
            return null;
        }

        return await this._generateFileInstance({...options, chunks: chunkIds});;
    }

    async uploadFile(fileReadStream, options) {
        await this.assertAccountManager();

        options = parseOptions(options, chunkifyUpload_OPTIONS_TEMPLATE);

        if(options.chunkSize == 0) // single-chunk file
            return await this.uploadChunkifiedFile([fileReadStream], {...options, fileType: options.fileType});

        let chunkify = new ChunkifyReadStream(options.chunkSize);
        fileReadStream.pipe(chunkify);
        let chunkStream;
        let chunkStreams = [];
        while(chunkStream = await chunkify.getNextChunkStream())
            chunkStreams.push(chunkStream)

        return await this.uploadChunkifiedFile(chunkStreams, {...options, fileType: `chunkified-${options.fileType}`});
    }


    async _generateFileInstance(obj) {
        let r =  await this.models.filesCollection.addFile(obj).catch(e => console.log(e));
        return r;
    }

    async uploadChunk(chunkStream, options) {
        await this.assertAccountManager();
        
        let media = new Media("text/plain", chunkStream);
        let selectedAccount =  await this.accountManager.getMostAvailableStorageAccount();
        if(!selectedAccount) {
            console.log("No available accounts!")
            return null;
        }

        let googleFileId = await selectedAccount.uploadFile(media).catch(e => console.log(e));

        if(!googleFileId)
            return null;

        // TODO: add better error handling here
        if(!(await selectedAccount.updateFilePermission(googleFileId).catch(e => console.log(e)))) { 
            console.log("Failed to set file permission to public")
            return null;
        }
        let chunk = await this.models.chunksCollection.addChunk({...options, fileType: options.fileType, replicas: [googleFileId]}).catch(e => console.log(e));

        return chunk;
    }
}