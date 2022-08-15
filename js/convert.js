function htons(b, i, v) {
b[i]   = (0xff & (v >> 8));
b[i+1] = (0xff & (v));
}

function ntohs(b, i) {
return ((0xff & b[i + 0]) << 8) |
((0xff & b[i + 1]));
}

function htonl(b, i, v) {
b[i+0] = (0xff & (v >> 24));
b[i+1] = (0xff & (v >> 16));
b[i+2] = (0xff & (v >> 8));
b[i+3] = (0xff & (v));
}

function ntohl(b, i) {
return ((0xff & b[i + 0]) << 24) |
((0xff & b[i + 1]) << 16) |
((0xff & b[i + 2]) << 8) |
((0xff & b[i + 3]));
}

function htonll(b, i, v) {
b[i+0] = (0xff & (v >> 56));
b[i+1] = (0xff & (v >> 48));
b[i+2] = (0xff & (v >> 40));
b[i+3] = (0xff & (v >> 32));
b[i+4] = (0xff & (v >> 24));
b[i+5] = (0xff & (v >> 16));
b[i+6] = (0xff & (v >> 8));
b[i+7] = (0xff & (v));
}

function ntohll(b,i) {
return ((0xff & b[i + 0]) << 56) |
((0xff & b[i + 1]) << 48) |
((0xff & b[i + 2]) << 40) |
((0xff & b[i + 3]) << 32) |
((0xff & b[i + 4]) << 24) |
((0xff & b[i + 5]) << 16) |
((0xff & b[i + 6]) << 8) |
((0xff & b[i + 7]));
}
