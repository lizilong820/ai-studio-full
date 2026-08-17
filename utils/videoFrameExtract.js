const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * 从视频中抽取关键帧并拼接为一张网格图
 */
function extractVideoFrames(videoPath, outputDir, frameCount) {
  frameCount = frameCount || 3;
  return new Promise(function(resolve, reject) {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    var baseName = path.basename(videoPath, path.extname(videoPath));
    var gridOutput = path.join(outputDir, baseName + '_grid.jpg');

    // 获取视频时长
    var probeCmd = 'ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "' + videoPath + '"';
    exec(probeCmd, function(probeErr, probeStdout) {
      var duration = 0;
      if (!probeErr) {
        duration = parseFloat(probeStdout.trim()) || 0;
      }

      var timePoints = [];
      if (duration > 1) {
        var startOffset = Math.min(0.5, duration * 0.1);
        for (var i = 0; i < frameCount; i++) {
          var t = startOffset + (duration - startOffset * 2) * (i / Math.max(frameCount - 1, 1));
          timePoints.push(t.toFixed(2));
        }
      } else {
        timePoints = ['0.1'];
      }

      var frames = [];
      var idx = 0;

      function extractNext() {
        if (idx >= timePoints.length) {
          if (frames.length === 0) {
            return reject(new Error('视频抽帧失败：未能提取任何帧'));
          }
          if (frames.length === 1) {
            fs.copyFileSync(frames[0], gridOutput);
            return resolve(gridOutput);
          }
          // 横向拼接
          var tileLayout = frames.length <= 3 ? frames.length + 'x1' : '3x' + Math.ceil(frames.length / 3);
          var inputs = '';
          for (var f = 0; f < frames.length; f++) {
            inputs += ' -i "' + frames[f] + '"';
          }
          var montageCmd = 'ffmpeg -y' + inputs + ' -filter_complex "tile=' + tileLayout + ':margin=10:padding=10:color=white" -q:v 2 "' + gridOutput + '" 2>/dev/null';
          exec(montageCmd, function(montageErr) {
            if (montageErr) {
              if (frames[0]) {
                fs.copyFileSync(frames[0], gridOutput);
                resolve(gridOutput);
              } else {
                reject(new Error('帧拼接失败: ' + montageErr.message));
              }
              return;
            }
            resolve(gridOutput);
          });
          return;
        }

        var t = timePoints[idx];
        var framePath = path.join(outputDir, baseName + '_f' + idx + '.jpg');
        var cmd = 'ffmpeg -y -ss ' + t + ' -i "' + videoPath + '" -vframes 1 -q:v 2 "' + framePath + '" 2>/dev/null';
        exec(cmd, function(err) {
          if (!err && fs.existsSync(framePath) && fs.statSync(framePath).size > 0) {
            frames.push(framePath);
          }
          idx++;
          extractNext();
        });
      }

      extractNext();
    });
  });
}

module.exports = { extractVideoFrames: extractVideoFrames };
