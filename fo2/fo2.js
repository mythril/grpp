const ncp = require('node:child_process');
const { globSync } = require('glob');
const request = require('request');
const fs = require('fs');
require('dotenv').config();
var readlineSync = require('readline-sync');
const { dirname } = require('node:path');

const root = dirname(__dirname);

const nb = (bin) => {
  return root + '/node_modules/.bin/' + bin;
}

let error = false;

process.chdir(__dirname);

const user = process.env.VECTORIZER_AI_USER || '';
const pass = process.env.VECTORIZER_AI_PASSWORD || '';

if (user.trim() === '') {
  console.error('Missing "VECTORIZER_AI_USER" in .env file');
  error = true;
}

if (pass.trim() === '') {
  console.error('Missing "VECTORIZER_AI_PASSWORD" in .env file');
  error = true;
}

if (error) {
  process.exit(1);
}

const exec = (cmd, silent = false) => {
  if (!silent) {
    console.log(cmd);
  }
  return ncp.execSync(cmd, (error, stdout, stderr) => {
    if (!silent) {
      if (error) {
        console.error(`exec error: ${error}`);
        return;
      }
      if (stdout) {
        console.log(`stdout: ${stdout}`);
      }
      if (stderr) {
        console.error(`stderr: ${stderr}`);
      }
    }
  });
}

const commandLineDependencies = {
  'convert': 'ImageMagick',
  'composite': 'ImageMagick',
  'montage': 'ImageMagick',
  'cwebp': 'webp',
};

for (let [command, package] of Object.entries(commandLineDependencies)) {
  const commandExists = exec(`which ${command} >/dev/null; echo $?`, true).toString().trim() === "0" ? true : false;
  if (!commandExists) {
    console.error(`Could not find command "${command}", usually installed with the "${package}" package.`);
    error = true;
  }
}

function sleep(millis) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

const bmpSrc = 'source-bitmaps';
const scratchDst = 'scratch';
const processedPngDst = 'prepped';
const svgs = 'svgs';
const csvgDst = 'compressed_svgs';
const dirs = [bmpSrc, scratchDst, processedPngDst, svgs, csvgDst];

for (let dir of dirs) {
  exec(`mkdir -p ${dir}`);
}

async function main() {
  const srcBmps = globSync(`${bmpSrc}/*.bmp`);

  if (!readlineSync.keyInYN(`There are ${srcBmps.length} images to process, does that seem correct?`)) {
    console.log(`Seems you need to move your source images to the 'fo2/${bmpSrc}' directory`);
    console.log('Canceling...');
    process.exit(1);
  }

  // blends all the vault boy images together using 'Lighten' operator to isolate the background
  exec(`convert ${bmpSrc}/*.bmp -background None -compose Lighten -layers Flatten ${scratchDst}/00-mage-bg.png`);

  for (let file of srcBmps) {
    const outFn = file.replace(`${bmpSrc}/`, `${processedPngDst}/`).replace(/\.bmp/i, '.png');
    console.log(outFn);

    // extracts background from individual vault boy image, leaving the line art and some artifacts, inverted
    exec(`composite ${scratchDst}/00-mage-bg.png "${file}" -compose difference ${scratchDst}/01-removed-bg.png`);

    // inverts colors back to 'normal'
    exec(`convert -negate ${scratchDst}/01-removed-bg.png ${scratchDst}/02-inverted.png`);

    // burns line art with original background to fill in line's intensity
    exec(`composite ${scratchDst}/00-mage-bg.png ${scratchDst}/02-inverted.png -compose color-burn ${scratchDst}/03-burn.png`);

    // converts to grayscale
    exec(`convert -fx '0.5*r+0.5*g+0.1*b' ${scratchDst}/03-burn.png ${scratchDst}/04-gray.png`);

    // levels contrast and brightness
    exec(`convert ${scratchDst}/04-gray.png -auto-level ${scratchDst}/05-leveled.png`);

    // converts white to alpha
    exec(`convert ${scratchDst}/05-leveled.png -alpha copy -channel alpha -negate +channel -fx '#000' ${scratchDst}/06-result.png`);

    // moves workpiece to destination
    exec(`cp ${scratchDst}/06-result.png "${outFn}"`);
  }

  // generates spritesheet
  exec(`montage -background transparent -density 140x117  ${processedPngDst}/*.png -geometry 140x117 ${scratchDst}/07-sprites.png`);

  // compresses spritesheet using webp
  exec(`cwebp ${scratchDst}/07-sprites.png -q 75 -alpha_q 75 -m 6 -o ${scratchDst}/08-sprites.webp`);

  let bitmaps = globSync(`${processedPngDst}/*.png`);
  let nextAttempt;

  console.log("Generating SVG (vectorized) images...");
  if (!readlineSync.keyInYN("This process may take hours, as there is a built in 5 minute delay between calls to the Vectorizer.ai API, do you wish to proceed?")) {
    console.log('Canceling...');
    process.exit(1);
  }

  // vectorizes each source bitmap using https://vectorizer.ai/
  for (let file of bitmaps) {
    nextAttempt = +(new Date()) + (1000 * 60 * 5); // 5 minutes between each call
    let svgfn = file.replace(processedPngDst, svgs).replace(/.png$/i, '.svg');
    if (fs.existsSync(svgfn)) {
      continue;
    }
    console.log('uploading: ', file);
    request.post({
      url: 'https://vectorizer.ai/api/v1/vectorize',
      formData: {
        image: fs.createReadStream(file),
        'processing.max_colors': 256
      },
      auth: { user, pass },
      followAllRedirects: true,
      encoding: null
    }, function (error, response, body) {
      if (error) {
        console.error('Request failed:', error);
      } else if (!response || response.statusCode != 200) {
        console.error('Error:', response && response.statusCode, body.toString('utf8'));
      } else {
        // Save result
        fs.writeFileSync(svgfn, body);
        process.stdout.write("\n" + svgfn + " - saved\n");
      }
    });

    while (+(new Date) < nextAttempt) {
      await sleep(10000);
      process.stdout.write('.');
    }

    process.stdout.write("\n");
  }

  // optimize svgs for filesize, copying to seperate directory
  exec(`${nb('svgo')} -f ${svgs} -o ${csvgDst}`);
};


main().then(() => console.log('done'));