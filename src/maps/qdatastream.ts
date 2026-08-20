/**
 * Reader for Qt's QDataStream wire format, as produced by Commander Wars'
 * `serializeObject` methods.
 *
 * Qt serialises big-endian by default. The primitives we need:
 *   qint32/quint32  4 bytes BE
 *   qint8/quint8    1 byte
 *   bool            1 byte
 *   float           4 bytes BE IEEE-754
 *   double/qreal    8 bytes BE IEEE-754
 *   QString         quint32 byte length (0xFFFFFFFF = null) + UTF-16BE
 *   QByteArray      quint32 byte length (0xFFFFFFFF = null) + raw bytes
 *   QPoint          two qint32
 */
export class QDataStreamReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(buffer: ArrayBufferLike, byteOffset = 0, byteLength?: number) {
    this.bytes = new Uint8Array(buffer, byteOffset, byteLength);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  get position(): number { return this.offset; }
  get length(): number { return this.bytes.byteLength; }
  get remaining(): number { return this.length - this.offset; }
  atEnd(): boolean { return this.offset >= this.length; }

  private need(count: number, what: string): void {
    if (this.offset + count > this.length) {
      throw new RangeError(
        `QDataStream: reading ${what} needs ${count} bytes at ${this.offset}, only ${this.remaining} left`);
    }
  }

  int8(): number { this.need(1, 'qint8'); return this.view.getInt8(this.offset++); }
  uint8(): number { this.need(1, 'quint8'); return this.view.getUint8(this.offset++); }
  bool(): boolean { return this.uint8() !== 0; }

  int32(): number {
    this.need(4, 'qint32');
    const value = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return value;
  }

  uint32(): number {
    this.need(4, 'quint32');
    const value = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  uint64(): bigint {
    this.need(8, 'quint64');
    const value = this.view.getBigUint64(this.offset, false);
    this.offset += 8;
    return value;
  }

  /**
   * A C++ `float` as written by Commander Wars.
   *
   * Qt's QDataStream defaults to QDataStream::DoublePrecision and Commander Wars
   * never calls setFloatingPointPrecision, so `operator<<(float)` emits EIGHT
   * bytes, not four. Reading these as float32 desyncs the stream — that single
   * mistake accounted for the Player::m_fundsModifier, Unit::m_hp and
   * CoreAI::m_BuildingChanceModifier failures.
   */
  float(): number { return this.double(); }

  /** A genuine 4-byte IEEE-754 value. Not used by the CW stream. */
  float32(): number {
    this.need(4, 'float32');
    const value = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return value;
  }

  double(): number {
    this.need(8, 'double');
    const value = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return value;
  }

  /** QString: quint32 byte length then UTF-16BE. 0xFFFFFFFF encodes a null string. */
  string(): string {
    const byteLength = this.uint32();
    if (byteLength === 0xFFFFFFFF) return '';
    if (byteLength === 0) return '';
    this.need(byteLength, `QString(${byteLength})`);
    let out = '';
    for (let i = 0; i < byteLength; i += 2) {
      out += String.fromCharCode(this.view.getUint16(this.offset + i, false));
    }
    this.offset += byteLength;
    return out;
  }

  /** QByteArray: quint32 byte length then raw bytes. */
  byteArray(): Uint8Array {
    const byteLength = this.uint32();
    if (byteLength === 0xFFFFFFFF) return new Uint8Array(0);
    this.need(byteLength, `QByteArray(${byteLength})`);
    const slice = this.bytes.subarray(this.offset, this.offset + byteLength);
    this.offset += byteLength;
    return slice;
  }

  point(): { x: number; y: number } {
    return { x: this.int32(), y: this.int32() };
  }

  /**
   * coreengine/filesupport.cpp: Filesupport::readByteArray — a qint32 count
   * followed by that many qint8. NOT the same as a QByteArray.
   */
  filesupportByteArray(): Uint8Array {
    const size = this.int32();
    if (size < 0) return new Uint8Array(0);
    this.need(size, `Filesupport byte array(${size})`);
    const slice = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return slice;
  }

  /** Filesupport::readVectorList<QString> — qint32 count then that many QStrings. */
  stringList(): string[] {
    const size = this.int32();
    const out: string[] = [];
    for (let i = 0; i < size; i++) out.push(this.string());
    return out;
  }

  skip(count: number): void {
    this.need(count, `skip(${count})`);
    this.offset += count;
  }
}
