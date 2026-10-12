export async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: Buffer | string) => {
      data += chunk.toString();
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
    process.stdin.on('error', (error) => {
      reject(error);
    });
  });
}
