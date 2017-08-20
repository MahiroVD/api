const crypto = require('crypto');
const Dicer = require('dicer');
const sw = require('../../lib/fileSeaweed');
const util = require('../../lib/util.js');

// Load configuration
const config = require('../../config.json');

// Create regexes
// Content-Disposition filename regex: "filename=xxx"
const ContentDispositionFilenameRegex = /filename=(?:("([^"]+)"|([^;"]+)))/;
// Content-Disposition name regex: "name=xxx"
const ContentDispositionNameRegex = /[^e]name=(?:"([^"]+)"|([^;]+))/;
// Filename regex
const FilenameRegex = /^(?:^.*)?\.([a-z0-9_-]+)$/i;
// Multipart Content-Type regex: "multipart/formdata; boundary=xxx"
const MultipartRegex = /^multipart\/form-data; boundary=(?:"([^"]+)"|([^;]+))$/;

function genKey (file) {
  return util.generateRandomKey() + (file.ext ? '.' + file.ext : '');
}

/**
 * Handle multipart pomf-compatible uploads.
 */
module.exports = (req, res) => {
  let files = [];

  // Check the Content-Length header
  if (req.headers['content-length'] && parseInt(req.headers['content-length']) > (config.maxFilesize * config.maxFilesPerUpload)) {
    res.end(413, JSON.stringify({
      success: false,
      errorcode: 413,
      description: 'content-length too large'
    }));
    return req.destroy();
  }

  // Check the Content-Type header
  let contentType = MultipartRegex.exec(req.headers['content-type']);
  if (contentType === null) {
    return res.end(400, JSON.stringify({
      success: false,
      errorcode: 400,
      description: 'invalid Content-Type header, must be multipart w/ boundary'
    }));
  }

  // Parse incoming data using BusBoy
  let d = new Dicer({
    boundary: contentType[1] || contentType[2],
    maxHeaderPairs: 50
  });
  d.on('part', p => {
    let file = {
      data: [],
      ext: null,
      filename: null,
      mime: null
    };
    p.on('header', head => {
      for (let h in head) {
        if (h === 'content-disposition') {
          let name = ContentDispositionNameRegex.exec(head[h][0]);
          if (name === null || name[1] !== 'files[]') {
            return res.end(400, JSON.stringify({
              success: false,
              errorcode: 400,
              description: 'form field name should be files[]'
            }), () => req.destroy());
          }
          let filename = ContentDispositionFilenameRegex.exec(head[h][0]);
          if (filename !== null) {
            file.filename = filename[2];
            let ext = FilenameRegex.exec(filename[2]);
            if (ext !== null) file.ext = ext[1].toLowerCase();
          }
        }
        if (h === 'content-type') file.mime = head[h][0];
      }
    });
    p.on('data', data => {
      file.data.push(data);
    });
    p.on('end', () => {
      if (files.length >= config.maxFilesPerUpload) {
        return res.end(400, JSON.stringify({
          success: false,
          errorcode: 400,
          description: 'too many files'
        }));
      }
      file.data = Buffer.concat(file.data);
      if (file.data.length > config.maxFilesize) {
        res.end(413, JSON.stringify({
          success: false,
          errorcode: 413,
          description: 'request payload too large'
        }));
        return req.destroy();
      }
      files.push(file);
    });
  }).on('error', err => {
    console.error('Dicer error:');
    console.error(err);
    return res.end(500, JSON.stringify({
      success: false,
      errorcode: 500,
      description: 'internal server error'
    }));
  }).on('finish', () => {
    if (res._headersSent || res.finished) return;
    if (files.length === 0) {
      return res.end(400, JSON.stringify({
        success: false,
        errorcode: 400,
        description: 'no input file(s)'
      }));
    }

    // Submit batch upload
    batchUpload(files).then(data => {
      if (data.length === 0) {
        // This should've been caught above, this is a server error
        console.error('batchUpload returned zero-length array.');
        return res.end(500, JSON.stringify({
          success: false,
          errorcode: 500,
          description: 'internal server error'
        }));
      }
      if (data.length === 1 && data[0].error) {
        return res.end(data[0].errorcode, JSON.stringify({
          success: false,
          errorcode: data[0].errorcode,
          description: data[0].description
        }));
      }

      // Send success response
      res.end(200, JSON.stringify({
        success: true,
        files: data
      }));
    }).catch(err => {
      console.error('Failed to batch upload:');
      console.error(err);
      res.end(500, JSON.stringify({
        success: false,
        errorcode: 500,
        description: 'internal server error'
      }));
    });
  });

  // Pipe request into Dicer
  req.pipe(d);
};

/**
 * Batch upload to S3 and return an array of metadata about each object.
 * @param {object[]} files File definitions
 * @return {Promise<object[]>} Output metadata
 */
function batchUpload (files) {
  return new Promise((resolve, reject) => {
    let completed = [];

    /**
     * Push data to completed and try to resolve the promise.
     * @param {object} data
     */
    function push (data) {
      completed.push(data);
      if (completed.length === files.length) resolve(completed);
    }

    // Iterate through all files and upload them
    files.forEach(file => {
      function createWithKey (key) {
        sw({
          key,
          contentType: file.mime || 'application/octet-stream',
          body: file.data
        }).then(data => {
          push({
            hash: crypto.createHash('sha1').update(file.data).digest('hex'),
            name: file.filename,
            url: key,
            size: file.data.length
          });
        })
        .catch(err => {
          if (err && err.code === '23505') {
            // key clash
            createWithKey(genKey(file));
            return;
          }
          console.error('Failed to upload file to S3:');
          console.error(err);
          return push({
            error: true,
            name: file.filename,
            errorcode: 500,
            description: 'internal server error'
          });
        });
      }
      createWithKey(genKey(file));
    });
  });
}
