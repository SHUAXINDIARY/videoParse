/**
 * Worker 内完成 MP4 解封装与 WebCodecs 解码。
 * ImageBitmap 通过 Transferable 返回，避免像素数据复制。
 */
import { createFile, DataStream, Endianness } from "https://cdn.jsdelivr.net/npm/mp4box@2.3.0/dist/mp4box.all.js";

const BYTES_PER_MB = 1024 * 1024;
const CHUNK_SIZE = 2 * BYTES_PER_MB;
const EXTRACTION_BATCH_SIZE = 24;
const MAX_DECODE_QUEUE_SIZE = 8;
const MICROSECONDS_PER_SECOND = 1000000;
const MICROSECONDS_PER_MILLISECOND = 1000;
const BOX_HEADER_BYTES = 8;

let mp4File = null;
let videoDecoder = null;
let sourceBlob = null;
let targetTrackId = null;
let pendingSamples = [];
let inputFinished = false;
let sourceFeedingComplete = false;
let refeedFromOffset = -1;
let extractedSampleCount = 0;
let decodedFrameCount = 0;
let doneSent = false;
let flushing = false;
let cancelled = false;
let failed = false;

const post = (type, payload, transferables = []) => {
    self.postMessage({ type, payload }, transferables);
};

/** 将可能含二进制或循环引用的 mp4box 结果安全地展示为 JSON。 */
const toDisplayValue = (value) => {
    const seen = new WeakSet();
    return JSON.parse(
        JSON.stringify(value, (_key, item) => {
            if (typeof item === "bigint") {
                return item.toString() + "n";
            }
            if (item instanceof ArrayBuffer) {
                return { type: "ArrayBuffer", byteLength: item.byteLength };
            }
            if (ArrayBuffer.isView(item)) {
                return { type: item.constructor.name, byteLength: item.byteLength };
            }
            if (item && typeof item === "object") {
                if (seen.has(item)) {
                    return "[Circular]";
                }
                seen.add(item);
            }
            return item;
        }),
    );
};

const reportError = (error) => {
    if (failed || cancelled) {
        return;
    }
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    post("error", { message });
};

const toMicroseconds = (value, timescale) => {
    if (!Number.isFinite(timescale) || timescale <= 0) {
        return 0;
    }
    return Math.round((Number(value) * MICROSECONDS_PER_SECOND) / timescale);
};

/** 提取 AVC/HVC 等编码格式初始化 WebCodecs 所需的 description。 */
const extractCodecDescription = (trackId) => {
    const trackBox = mp4File?.getTrackById(trackId);
    const sampleEntry = trackBox?.mdia?.minf?.stbl?.stsd?.entries?.[0];
    if (!sampleEntry) {
        return undefined;
    }

    for (const value of Object.values(sampleEntry)) {
        if (!value || typeof value.write !== "function") {
            continue;
        }
        const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
        value.write(stream);
        if (stream.buffer.byteLength > BOX_HEADER_BYTES) {
            return new Uint8Array(stream.buffer, BOX_HEADER_BYTES);
        }
    }
    return undefined;
};

const sendProgress = (phase) => {
    post("progress", {
        phase,
        decodedFrameCount,
        pendingSampleCount: pendingSamples.length,
    });
};

const maybeFinish = async () => {
    if (
        cancelled ||
        failed ||
        doneSent ||
        flushing ||
        !inputFinished ||
        !sourceFeedingComplete ||
        !videoDecoder ||
        pendingSamples.length > 0 ||
        videoDecoder.decodeQueueSize > 0
    ) {
        return;
    }

    flushing = true;
    try {
        await videoDecoder.flush();
        if (!cancelled && !failed) {
            doneSent = true;
            post("done", { decodedFrameCount });
        }
    } catch (error) {
        reportError(error);
    } finally {
        flushing = false;
    }
};

const pumpDecodeQueue = () => {
    if (
        cancelled ||
        failed ||
        !videoDecoder ||
        targetTrackId === null ||
        videoDecoder.state !== "configured"
    ) {
        return;
    }

    while (pendingSamples.length > 0 && videoDecoder.decodeQueueSize < MAX_DECODE_QUEUE_SIZE) {
        const sample = pendingSamples.shift();
        if (!sample?.data) {
            continue;
        }
        try {
            videoDecoder.decode(
                new EncodedVideoChunk({
                    type: sample.is_sync ? "key" : "delta",
                    timestamp: toMicroseconds(sample.cts, sample.timescale),
                    duration: toMicroseconds(sample.duration, sample.timescale) || undefined,
                    data: sample.data,
                }),
            );
            mp4File?.releaseUsedSamples(targetTrackId, sample.number + 1);
        } catch (error) {
            reportError(error);
            return;
        }
    }
    sendProgress("正在解码");
    void maybeFinish();
};

const configureDecoder = (track) => {
    if (!("VideoDecoder" in self)) {
        throw new Error("当前 Worker 环境不支持 WebCodecs VideoDecoder");
    }

    const description = extractCodecDescription(track.id);
    const decoderConfig = {
        codec: track.codec,
        codedWidth: Math.round(track.video?.width ?? track.track_width ?? 0),
        codedHeight: Math.round(track.video?.height ?? track.track_height ?? 0),
        optimizeForLatency: true,
        ...(description ? { description } : {}),
    };

    videoDecoder = new VideoDecoder({
        output: async (frame) => {
            let bitmap = null;
            try {
                if (cancelled || failed) {
                    return;
                }
                bitmap = await createImageBitmap(frame);
                const timestampUs = frame.timestamp ?? 0;
                post(
                    "frame",
                    {
                        index: decodedFrameCount,
                        timestampMs: Math.round(timestampUs / MICROSECONDS_PER_MILLISECOND),
                        bitmap,
                    },
                    [bitmap],
                );
                bitmap = null;
                decodedFrameCount += 1;
            } catch (error) {
                reportError(error);
            } finally {
                bitmap?.close();
                frame.close();
                pumpDecodeQueue();
                void maybeFinish();
            }
        },
        error: reportError,
    });
    videoDecoder.configure(decoderConfig);

    return {
        ...decoderConfig,
        description: description
            ? { type: "Uint8Array", byteLength: description.byteLength }
            : undefined,
    };
};

/** 分片追加数据；每一块都必须标明其原始文件偏移。 */
const feedBlob = async (startOffset) => {
    let offset = startOffset;
    while (offset < sourceBlob.size && !cancelled && !failed) {
        const end = Math.min(offset + CHUNK_SIZE, sourceBlob.size);
        const buffer = await sourceBlob.slice(offset, end).arrayBuffer();
        buffer.fileStart = offset;
        mp4File.appendBuffer(buffer);
        offset = end;
        post("input-progress", { loadedBytes: offset, totalBytes: sourceBlob.size });
    }
};

/** 获取 mp4box 为重新读取媒体数据建议的起始偏移。 */
const resolveRefeedOffset = () => {
    const seekResult = mp4File?.seek(0, true);
    const offset = Number(seekResult?.offset);
    return Number.isFinite(offset) && offset > 0 ? offset : -1;
};

const start = async (file) => {
    try {
        sourceBlob = file;
        mp4File = createFile();
        mp4File.onError = (_module, message) => reportError(new Error(message));
        mp4File.onReady = (info) => {
            try {
                const videoTrack = info.tracks.find((track) => Boolean(track.video));
                if (!videoTrack) {
                    throw new Error("MP4 中未找到视频轨道");
                }

                targetTrackId = videoTrack.id;
                const decoderConfig = configureDecoder(videoTrack);
                post("mp4-metadata", {
                    mp4boxInfo: toDisplayValue(info),
                    selectedVideoTrack: toDisplayValue(videoTrack),
                    decoderConfig,
                });

                mp4File.setExtractionOptions(videoTrack.id, undefined, {
                    nbSamples: EXTRACTION_BATCH_SIZE,
                });
                mp4File.start();

                if (inputFinished) {
                    refeedFromOffset = resolveRefeedOffset();
                }
                pumpDecodeQueue();
            } catch (error) {
                reportError(error);
            }
        };
        mp4File.onSamples = (trackId, _user, samples) => {
            if (trackId !== targetTrackId || cancelled || failed) {
                return;
            }
            extractedSampleCount += samples.length;
            pendingSamples.push(...samples);
            pumpDecodeQueue();
        };

        post("progress", { phase: "读取 MP4 容器", decodedFrameCount: 0, pendingSampleCount: 0 });
        await feedBlob(0);
        inputFinished = true;
        mp4File.flush();

        /*
         * moov 在文件尾部时，onReady 可能发生在首轮读取结束之前。
         * 此时需在 flush 后确认没有样本，再按 mp4box 给出的偏移重新喂入 mdat 数据。
         */
        if (refeedFromOffset < 0 && extractedSampleCount === 0 && targetTrackId !== null) {
            refeedFromOffset = resolveRefeedOffset();
        }
        if (refeedFromOffset >= 0 && !cancelled && !failed) {
            post("progress", {
                phase: "重新读取 MP4 媒体数据",
                decodedFrameCount,
                pendingSampleCount: pendingSamples.length,
            });
            await feedBlob(refeedFromOffset);
            mp4File.flush();
        }
        sourceFeedingComplete = true;
        if (extractedSampleCount === 0) {
            throw new Error("MP4 未提取到可解码的视频样本");
        }
        pumpDecodeQueue();
        await maybeFinish();
    } catch (error) {
        reportError(error);
    }
};

self.onmessage = (event) => {
    if (event.data.type === "start") {
        void start(event.data.file);
    }
    if (event.data.type === "cancel") {
        cancelled = true;
        pendingSamples = [];
        try {
            mp4File?.stop();
            videoDecoder?.close();
        } catch (_error) {
            // 任务终止时资源可能已关闭，无需额外处理。
        }
    }
};
