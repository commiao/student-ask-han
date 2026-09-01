import { copyFileSync, existsSync, statSync } from 'node:fs';
const SRC = '/Users/mac/Library/Containers/com.tencent.xWeChat/Data/Documents/xwechat_files/jingmiao0924_5519/msg/file/2026-08/电子信息工程学院新生必备指南.pdf';
const DST = '/Users/mac/work-deepseek/kb/src.pdf';
copyFileSync(SRC, DST);
console.log('copied', statSync(DST).size, existsSync(DST));
