'use strict'

module.exports = function (txt, options) {
  return new CopyStreamQuery(txt, options)
}

const { Transform } = require('stream')
const BufferList = require('obuf')
const code = require('./message-formats')

// decoder states
const PG_CODE = 0
const PG_LENGTH = 1
const PG_MESSAGE = 2

class CopyStreamQuery extends Transform {
  constructor(text, options) {
    super(options)
    this.text = text
    this.rowCount = 0
    this._state = PG_CODE
    this._buffer = new BufferList()
    this._unreadMessageContentLength = 0
    this._copyDataChunks = new BufferList()
  }

  submit(connection) {
    connection.query(this.text)
    this.connection = connection
    this.connection.removeAllListeners('copyData')
    connection.stream.pipe(this)
  }

  _detach() {
    const connectionStream = this.connection.stream
    connectionStream.unpipe(this)

    // unpipe can pause the stream but also underlying onData event can potentially pause the stream because of hitting
    // the highWaterMark and pausing the stream, so we resume the stream in the next tick after the underlying onData
    // event has finished
    process.nextTick(function () {
      connectionStream.resume()
    })
  }

  _cleanup() {
    this._buffer = null
    this._copyDataChunks = null
  }

  _transform(chunk, enc, cb) {
    let done = false
    this._buffer.push(chunk)

    while (this._buffer.size > 0) {
      if (PG_CODE === this._state) {
        if (!this._buffer.has(1)) break
        this._code = this._buffer.readUInt8()
        this._state = PG_LENGTH
      }

      if (PG_LENGTH === this._state) {
        if (!this._buffer.has(4)) break
        this._unreadMessageContentLength = this._buffer.readUInt32BE() - 4
        this._state = PG_MESSAGE
      }

      if (PG_MESSAGE === this._state) {
        if (this._unreadMessageContentLength > 0 && this._buffer.size > 0) {
          const n = Math.min(this._buffer.size, this._unreadMessageContentLength)
          const messageContentChunk = this._buffer.take(n)
          this._unreadMessageContentLength -= n
          if (this._code === code.CopyData) {
            this._copyDataChunks.push(messageContentChunk)
          }
        }

        if (this._unreadMessageContentLength === 0) {
          // a full message has been captured
          switch (this._code) {
            case code.CopyOutResponse:
              break
            case code.CopyData:
              this.rowCount++
              break
            // standard interspersed messages.
            // see https://www.postgresql.org/docs/9.6/protocol-flow.html#PROTOCOL-COPY
            case code.ParameterStatus:
            case code.NoticeResponse:
            case code.NotificationResponse:
              break
            case code.CopyDone:
            case code.ErrorResponse:
            default:
              done = true
              break
          }
          this._state = PG_CODE
        }
      }
    }

    // flush data if any data has been captured
    const len = this._copyDataChunks.size
    if (len > 0) {
      this.push(this._copyDataChunks.take(len))
    }

    if (done) {
      this._detach()
      this.push(null)
      this._cleanup()
    }

    cb()
  }

  handleError(e) {
    this.emit('error', e)
  }

  handleCopyData(chunk) {}

  handleCommandComplete() {}

  handleReadyForQuery() {}
}
