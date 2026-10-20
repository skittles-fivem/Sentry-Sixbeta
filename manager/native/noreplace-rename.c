/*
 * noreplace-rename FROM TO
 *
 * Atomically renames FROM to TO only if TO does not exist, using
 * renameat2(RENAME_NOREPLACE). Node has no binding for it. On SMB mounts the
 * Linux CIFS client turns this into a server-side rename that refuses to
 * replace, so an existing file can never be overwritten in a race.
 *
 * Exit 0 on success. Otherwise prints the errno name (EEXIST, ENOENT,
 * EINVAL, ...) on stdout and exits 1.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif

static const char *errno_name(int e) {
  switch (e) {
    case EEXIST: return "EEXIST";
    case ENOENT: return "ENOENT";
    case EINVAL: return "EINVAL";
    case ENOSYS: return "ENOSYS";
    case EXDEV: return "EXDEV";
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case EBUSY: return "EBUSY";
    case EIO: return "EIO";
    case ENOTDIR: return "ENOTDIR";
    case EISDIR: return "EISDIR";
    case ENOTEMPTY: return "ENOTEMPTY";
    case EROFS: return "EROFS";
    case ENOSPC: return "ENOSPC";
    case ETIMEDOUT: return "ETIMEDOUT";
    case EHOSTDOWN: return "EHOSTDOWN";
    case ESTALE: return "ESTALE";
    case EAGAIN: return "EAGAIN";
    case ENOTCONN: return "ENOTCONN";
    case EOPNOTSUPP: return "EOPNOTSUPP";
    default: return "EIO";
  }
}

int main(int argc, char **argv) {
  if (argc != 3 || argv[1][0] != '/' || argv[2][0] != '/') {
    fputs("usage: noreplace-rename /abs/from /abs/to\n", stderr);
    puts("EINVAL");
    return 2;
  }
  if (syscall(SYS_renameat2, AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_NOREPLACE) == 0) return 0;
  puts(errno_name(errno));
  return 1;
}
