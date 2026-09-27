import { assertEquals, assertThrows } from '@std/assert';
import { Database } from '@db/sqlite';
import { StatementCache } from './statementCache.ts';

Deno.test('statement cache bounds live native statements and keeps frequently used SQL hot', () => {
  const db = new Database(':memory:');
  const prepared: string[] = [];
  let live = 0;
  let peak = 0;
  const cache = new StatementCache({
    prepare(sql: string) {
      const statement = db.prepare(sql);
      prepared.push(sql);
      peak = Math.max(peak, ++live);
      const finalize = statement.finalize.bind(statement);
      statement.finalize = () => {
        live--;
        finalize();
      };
      return statement;
    },
  }, 2);
  try {
    const read = (sql: string, value: number) =>
      cache.execute(sql, (statement) => statement.values(value));
    assertEquals(read('select ?', 1), [[1]]);
    for (let index = 0; index < 20; index++) {
      assertEquals(read(`select ? + ${index}`, 2), [[2 + index]]);
      assertEquals(read('select ?', index), [[index]]);
    }
    assertEquals(prepared.filter((sql) => sql === 'select ?').length, 1);
    assertEquals(live, 2);
    assertEquals(peak, 2);
    // An evicted statement can be prepared and executed again.
    assertEquals(read('select ? + 0', 9), [[9]]);
    assertEquals(prepared.filter((sql) => sql === 'select ? + 0').length, 2);
  } finally {
    db.close();
  }
});

Deno.test('failed cached writes preserve their error and do not poison subsequent queries', () => {
  const db = new Database(':memory:');
  const cache = new StatementCache(db, 1);
  try {
    db.exec('create table entries (id integer primary key)');
    const insert = (id: number) =>
      cache.execute('insert into entries values (?)', (statement) => statement.run(id));
    insert(1);
    assertThrows(() => insert(1), Error, 'UNIQUE constraint failed');
    assertEquals(cache.execute('select count(*) from entries', (s) => s.values()), [[1]]);
    insert(2);
    assertEquals(cache.execute('select id from entries order by id', (s) => s.values()), [[1], [
      2,
    ]]);
    assertThrows(() => cache.execute('select from invalid', (s) => s.values()));
    assertEquals(cache.execute('select 3', (s) => s.values()), [[3]]);
  } finally {
    db.close();
  }
});
