const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');

function createClient(settings) {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    endpoint: settings.endpoint || undefined,
    region: settings.region || 'auto',
    forcePathStyle: Boolean(settings.forcePathStyle),
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey
    }
  });
}

class S3Vault {
  constructor(settings) {
    this.settings = settings;
    this.client = createClient(settings);
  }

  async testConnection() {
    const { HeadBucketCommand } = require('@aws-sdk/client-s3');
    await this.client.send(new HeadBucketCommand({ Bucket: this.settings.bucket }));
    return { ok: true, message: 'Cloud bucket connection succeeded.' };
  }

  async upload({ sourcePath, objectKey, contentType = 'application/octet-stream' }) {
    const { Upload } = require('@aws-sdk/lib-storage');
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.settings.bucket,
        Key: objectKey,
        Body: fs.createReadStream(sourcePath),
        ContentType: contentType
      },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false
    });
    await upload.done();
    return { objectKey };
  }

  async restore({ objectKey, destinationPath }) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.settings.bucket,
      Key: objectKey
    }));
    if (!response.Body) throw new Error('Cloud object returned no data.');
    await pipeline(response.Body, fs.createWriteStream(destinationPath, { flags: 'wx' }));
  }

  async deleteObjects({ objects = [], objectKeys = [] }) {
    const { DeleteObjectsCommand } = require('@aws-sdk/client-s3');
    const keys = objects.length ? objects.map((item) => item.objectKey).filter(Boolean) : objectKeys;
    const uniqueKeys = [...new Set(keys || [])];
    let deleted = 0;

    for (let index = 0; index < uniqueKeys.length; index += 1000) {
      const keys = uniqueKeys.slice(index, index + 1000);
      if (!keys.length) continue;
      const response = await this.client.send(new DeleteObjectsCommand({
        Bucket: this.settings.bucket,
        Delete: {
          Objects: keys.map((Key) => ({ Key })),
          Quiet: true
        }
      }));

      if (response.Errors?.length) {
        const first = response.Errors[0];
        throw new Error(`Cloud deletion failed for ${first.Key || 'an object'}: ${first.Message || first.Code || 'unknown error'}`);
      }
      deleted += keys.length;
    }

    return { deleted };
  }
}

module.exports = { S3Vault };
