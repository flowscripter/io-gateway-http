declare module "@flowscripter/io-plugin-http" {
  import type { IOProvider, PayloadKind } from "@flowscripter/pluggable-io-framework-api";
  export class HttpIOProvider implements IOProvider<PayloadKind.Js> {
    constructor(config: Record<string, unknown>);
    readonly kind: PayloadKind.Js;
    [Symbol.asyncDispose](): Promise<void>;
    getProperties: IOProvider<PayloadKind.Js>["getProperties"];
    delete: NonNullable<IOProvider<PayloadKind.Js>["delete"]>;
    getReadableStream: IOProvider<PayloadKind.Js>["getReadableStream"];
    getWritableStream: IOProvider<PayloadKind.Js>["getWritableStream"];
  }
}

declare module "@flowscripter/io-plugin-filesystem" {
  import type { IOProvider, PayloadKind } from "@flowscripter/pluggable-io-framework-api";
  export class FilesystemIOProvider implements IOProvider<PayloadKind.Js> {
    constructor(rootPath?: string);
    readonly kind: PayloadKind.Js;
    [Symbol.asyncDispose](): Promise<void>;
    getProperties: IOProvider<PayloadKind.Js>["getProperties"];
    getReadableStream: IOProvider<PayloadKind.Js>["getReadableStream"];
    getWritableStream: IOProvider<PayloadKind.Js>["getWritableStream"];
  }
}

declare module "@flowscripter/io-plugin-s3" {
  import type { IOProvider, PayloadKind } from "@flowscripter/pluggable-io-framework-api";
  export class S3IOProvider implements IOProvider<PayloadKind.Js> {
    constructor(config: {
      bucket: string;
      region?: string;
      endpoint?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
    });
    readonly kind: PayloadKind.Js;
    [Symbol.asyncDispose](): Promise<void>;
    getProperties: IOProvider<PayloadKind.Js>["getProperties"];
    delete: NonNullable<IOProvider<PayloadKind.Js>["delete"]>;
    getReadableStream: IOProvider<PayloadKind.Js>["getReadableStream"];
    getWritableStream: IOProvider<PayloadKind.Js>["getWritableStream"];
  }
}
