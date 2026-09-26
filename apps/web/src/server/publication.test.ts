/**
 * Reader guard tests: the deployed v2 reader must refuse an exporter-v1 or
 * partially-built database with one actionable re-export message instead of a
 * raw "no such table" SQL error on every request.
 */
import { createPublicationSchema, type SqliteDatabase } from "@mmstar/results";
import { openSqliteDatabase } from "@mmstar/results/node";
import { afterEach, describe, expect, it } from "vitest";
import { assertPublicationReadable, PublicationUnavailableError } from "./publication";

const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function seedDatabase(): SqliteDatabase {
  const database = openSqliteDatabase(":memory:");
  databases.push(database);
  createPublicationSchema(database);
  return database;
}

describe("assertPublicationReadable", () => {
  it("accepts a schema-v2 database that holds every required view", () => {
    expect(() => assertPublicationReadable(seedDatabase())).not.toThrow();
  });

  it("rejects a database that is not a publication at all", () => {
    const database = openSqliteDatabase(":memory:");
    databases.push(database);
    expect(() => assertPublicationReadable(database)).toThrow(PublicationUnavailableError);
    expect(() => assertPublicationReadable(database)).toThrow(/not a publication database/);
  });

  it("rejects an exporter-v1 database with a re-export message", () => {
    const database = seedDatabase();
    database.prepare("UPDATE publication_meta SET value = '1' WHERE key = 'schema_version'").run();
    expect(() => assertPublicationReadable(database)).toThrow(/declares schema v1/);
    expect(() => assertPublicationReadable(database)).toThrow(/re-export the runs/i);
  });

  it("rejects a database missing a required view", () => {
    const database = seedDatabase();
    database.exec("DROP VIEW v_global_evaluation_summary");
    expect(() => assertPublicationReadable(database)).toThrow(/missing required views/);
    expect(() => assertPublicationReadable(database)).toThrow(/v_global_evaluation_summary/);
  });
});
