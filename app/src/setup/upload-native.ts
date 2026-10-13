import { File } from 'expo-file-system';

import { uploadPart, type FilePart, type UploadPart } from './upload';

/** A picked document as a multipart file part the iPad's `fetch` can send (T80). */
export const nativeUploadPart = (file: FilePart): UploadPart => uploadPart(file, (uri) => new File(uri).bytes());
