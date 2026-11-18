import type { FileTransferEndpoint } from "@jumpserver/connectors-core";
import type { SftpFileEntry } from "#koko/composables/sftp/protocol";
import type { Run } from "./sessions";
import { decodeSftpRawBytes, encodeSftpBytes } from "#koko/composables/sftp/core/codec";

import { sha256Hex as sha, emptyTransferChecksumState, chainTransferChecksum } from "#koko/utils/file-transfer/sha256";
const limit = 1024 * 1024;
export function mcpFileOperations(
  endpoint: FileTransferEndpoint,
  list: (path: string) => Promise<SftpFileEntry[]>
): Run {
  return async ({ op, value: remote, data }, check) => {
    if (op === "command") throw new Error("SFTP operation required");
    const id = crypto.randomUUID();
    const name = remote.slice(remote.lastIndexOf("/") + 1);
    const parent = remote.slice(0, remote.lastIndexOf("/")) || "/";
    if (op === "upload") {
      if (typeof data !== "string") throw new Error("Missing local upload");
      const bytes = decodeSftpRawBytes(data);
      if (bytes.length > limit) throw new Error("Upload exceeds 1 MiB");
      const digest = await sha(bytes);
      await check();
      const base = { transferId: id, targetPath: remote };
      const prepared = await endpoint.prepareTransfer({
        ...base,
        fileName: name,
        size: bytes.length,
        conflictPolicy: "skip"
      });
      if (prepared.state !== "ready" || prepared.committedBytes !== 0)
        throw new Error("Destination exists or transfer unavailable");
      try {
        if (bytes.length) {
          await check();
          const ack = await endpoint.writeChunk({
            ...base,
            totalBytes: bytes.length,
            offset: 0,
            sha256: digest,
            data: bytes
          });
          if (ack.committedBytes !== bytes.length) throw new Error("Incomplete SFTP write");
        }
        await check();
        const state = emptyTransferChecksumState();
        const checksum = bytes.length ? await chainTransferChecksum(state, digest) : state;
        await check();
        await endpoint.commitTransfer({ ...base, totalBytes: bytes.length, sha256: checksum, conflictPolicy: "skip" });
      } catch (e) {
        await check();
        await endpoint.cancelTransfer({ ...base, discard: true }).catch(() => {});
        throw e;
      }
      return { status: "upload acknowledged", path: remote, bytes: bytes.length, sha256: digest };
    }
    if (op === "logs") {
      if (!remote.startsWith("/var/log/")) throw new Error("Invalid log path");
      let dir = "/";
      for (const component of parent.slice(1).split("/")) {
        await check();
        const entry = (await list(dir)).find((e) => e.name === component);
        if (!entry?.is_dir || !entry.perm.startsWith("d")) throw new Error("Log directory is not a regular directory");
        dir = dir === "/" ? dir + component : `${dir}/${component}`;
      }
    }
    await check();
    const entry = (await list(parent)).find((e) => e.name === name);
    if (!entry || entry.is_dir || !entry.perm.startsWith("-")) throw new Error("Select a regular file");
    const buffer = new Uint8Array(limit);
    let size = 0;
    for (;;) {
      await check();
      const chunk = await endpoint.readChunk({
        transferId: id,
        path: remote,
        offset: size,
        length: Math.min(65536, limit + 1 - size)
      });
      if (
        chunk.offset !== size ||
        size + chunk.data.length > limit ||
        (!chunk.eof && !chunk.data.length) ||
        (chunk.data.length && (await sha(chunk.data)) !== chunk.sha256.toLowerCase())
      )
        throw new Error("File exceeds 1 MiB or chunk integrity check failed");
      buffer.set(chunk.data, size);
      size += chunk.data.length;
      if (chunk.eof) break;
    }
    const bytes = buffer.subarray(0, size);
    if (op === "download") return { data: encodeSftpBytes(bytes) };
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trimEnd().split(/\r?\n/);
    return { status: "read", path: remote, output: lines.slice(-100).join("\n").slice(-16000) };
  };
}
