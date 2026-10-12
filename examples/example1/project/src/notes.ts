import * as fs from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { DomainError } from './errors';

const VALID_NAME = /^[A-Za-z0-9_-]+$/;

export function validateName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new DomainError(`Invalid note name: ${name}`);
  }
}

export function getNotePath(notesDir: string, name: string): string {
  validateName(name);
  return path.join(notesDir, `${name}.txt`);
}

export function ensureNotesDir(notesDir: string): void {
  try {
    fs.mkdirSync(notesDir, { recursive: true });
  } catch (error) {
    throw new DomainError(`Failed to create notes directory: ${errorMessage(error)}`);
  }
}

export function createNote(notesDir: string, name: string, text: string): void {
  const filePath = getNotePath(notesDir, name);
  ensureNotesDir(notesDir);

  try {
    fs.writeFileSync(filePath, text, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new DomainError(`Note already exists: ${name}`);
    }
    throw new DomainError(`Failed to create note: ${errorMessage(error)}`);
  }
}

export function overwriteNote(notesDir: string, name: string, text: string): void {
  const filePath = getNotePath(notesDir, name);
  ensureNotesDir(notesDir);

  if (!fs.existsSync(filePath)) {
    throw new DomainError(`Note not found: ${name}`);
  }

  try {
    fs.writeFileSync(filePath, text, { encoding: 'utf8' });
  } catch (error) {
    throw new DomainError(`Failed to overwrite note: ${errorMessage(error)}`);
  }
}

export function showNote(notesDir: string, name: string): string {
  const filePath = getNotePath(notesDir, name);

  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new DomainError(`Note not found: ${name}`);
    }
    throw new DomainError(`Failed to read note: ${errorMessage(error)}`);
  }
}

export function deleteNote(notesDir: string, name: string): void {
  const filePath = getNotePath(notesDir, name);

  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new DomainError(`Note not found: ${name}`);
    }
    throw new DomainError(`Failed to delete note: ${errorMessage(error)}`);
  }
}

export function listNotes(notesDir: string): string[] {
  let entries: Dirent[];

  try {
    entries = fs.readdirSync(notesDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw new DomainError(`Failed to list notes: ${errorMessage(error)}`);
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.txt'))
    .map((entry) => entry.name.slice(0, -'.txt'.length))
    .sort();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
