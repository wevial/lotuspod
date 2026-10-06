# Nightly backups to a second disk

A plan for copying the site's database to a second disk each night, so a
failed disk costs at most one day of comments and answers.

## Context

The site keeps every comment, answer and agent reply in one database file on
one disk. Today a copy is made by hand when someone remembers, and the last
one is three weeks old.

## Approach

A timer starts the backup job at two each night, when nobody is publishing.
The job copies the database to the second disk, then opens the copy and reads
it back before it deletes the oldest one, so a broken copy never replaces a
good one. The second disk keeps the last seven copies.

## Rollout

Run the job once by hand and restore its copy into a scratch directory. Turn
the timer on only after that restore reads back every page's threads.

## Decisions for the maintainer

| # | Question | Options | Default | Why it matters |
|---|---|---|---|---|
| 1 | Which disk holds the copies? | Second internal disk / External USB disk | Second internal disk | A USB disk can be unplugged by mistake. |
| 2 | How many nightly copies are kept? | Seven / Fourteen | Seven | Each copy is about two gigabytes. |
