/**
 * @file: index.js
 * @description: (baidu)tieba static resource path migration tool
 * @version: 1.0.0
 * @author: guoshuyan@baidu.com
 */
var fs = require('fs');
var http = require('http');
var path = require('path');

var walk = require('walk');
var fse = require('fs-extra');
var program = require('commander');

var rootPath;
var staticPath = 'static';
var moduleName;
var staticFolder;

var httpStaticPath     = 'http://tb2.bdstatic.com';  // url地址域名替换地址
var cssExtension       = ['.css', '.less'];          //
var referenceExtension = ['.php', '.html', '.js'];   //
var resourceExtension  = ['.png', '.jpeg', '.jpg', '.gif', '.cur', '.swf']; // 这些都算做静态文件吧
var ignorePath         = ['_build', 'output', '.svn', '.idea', '.git'];     // 忽略的路径
var tiebaDomain        = ['tb1.bdstatic.com', 'tb2.bdstatic.com', 'tieba.baidu.com', 'static.tieba.baidu.com'];

// parse参数
program
  .version('1.0.0')
  .option('-p, --path <file>', '目录', readRootPath)
  .option('-m, --module <moduleName>', '主模块名', readModuleName)
  .parse(process.argv);

function readRootPath(param) {
    rootPath = path.resolve(param);
}

function readModuleName(params) {
    moduleName = params;
}

if (!rootPath || !moduleName) {
    console.error('\n ！请指定参数');
    program.help();
} else {
    staticPath = path.resolve(rootPath, staticPath);
    staticFolder = '/tb/static-' + moduleName;
}

// 大walk处理，得到需要处理的文件列表
var resourceFileList = [];// 待处理的资源文件列表
var cssFileList = {};     // 待处理的css文件列表
var cssFileCounter = 0;   // 待处理的css文件计数器

var processFunctions = {
    replaceAgain: function (absPathWithFileName, callback) {
        var tinfo = cssFileList[absPathWithFileName].processCache;
        fs.readFile(absPathWithFileName, {
            encoding: 'utf-8'
        }, function (err, content) {
            if (err) {
                throw err;
            }
            var replaces = content.replace(/url\(.*\)/gi, function (original) {
                return tinfo[original];
            });

            // 这里直接替换，并没有发现什么问题
            fs.writeFile(absPathWithFileName, replaces, function (err) {
                if (err) {
                    throw err;
                }
                callback();
            });
        });
    },

    getDomain: function (url) {
        return url.match('//([^/]*)')[1];
    },

    clearing: function (finalResult, original, cssFileAbsPath) {
        cssFileList[cssFileAbsPath].processCache[original] = finalResult;
        cssFileList[cssFileAbsPath].processIndex--;

        if (cssFileList[cssFileAbsPath].processIndex === 0) {
            // 分析完毕，开始改写
            this.replaceAgain(cssFileAbsPath, function () {
                cssFileCounter--;
                if (cssFileCounter === 0) {
                    console.log("DONE!");
                }
            });
        }
    },

    download: function (url, original, cssFileAbsPath) {
        var that = this;
        var relPath = path.dirname(cssFileAbsPath);
        var imageName = path.basename(url);
        var targetPath = path.join(relPath, '/images/', imageName);

        http.get(url, function (res) {
            if (res.statusCode === 200) {
                var imageData = '';
                res.setEncoding('binary');
                res.on('data', function (trunk) {
                    imageData += trunk;
                }).on('end', function () {
                    fs.writeFile(targetPath, imageData, 'binary', function (error) {
                        if (error) {
                            throw error;
                        }
                        that.clearing('url(images/' + imageName + ')', original, cssFileAbsPath);
                    });
                }); // todo timeout?
            } else {
                throw new Error('无法从网络上获取该文件' + cssFileAbsPath + '@' + original);
            }
        }).on('error', function (error) {
            throw error;
        });
    },

    // 如果存在正规目录，标准化即可，否则copy后标准化
    changePath: function (url, original, cssFileAbsPath) {
        var that = this;
        var relPath = path.dirname(cssFileAbsPath);
        var sourcePath = path.resolve(relPath, url);

        if (url.indexOf('images') === 0 && fs.existsSync(sourcePath)) {
            this.clearing('url(' + url + ')', original, cssFileAbsPath);
        } else {
            var imageName = path.basename(url);
            var targetPath = path.join(relPath, '/images/', imageName);
            fse.copy(sourcePath, targetPath, function (error) {
                if (error) {
                    throw error;
                }
                that.clearing('url(images/' + imageName  + ')', original, cssFileAbsPath);
            });
        }
    }
};

walk.walk(rootPath, {
    followLinks: false,
    filters: ignorePath
}).on('file', function (root, fileStat, next) {
    var fileName = fileStat.name;
    var fileExtName = path.extname(fileName);
    var absPathWithFileName = path.resolve(root, fileName);
    var absImagesFolderPath = path.resolve(absPathWithFileName, '../images');

    if (resourceExtension.indexOf(fileExtName) > -1) {
        resourceFileList.push({
            fileName: fileName,
            root: root
        });
    } else if (cssExtension.indexOf(fileExtName) > -1) {
        fs.readFile(absPathWithFileName, { // readFile竟然不是异步？！
            encoding: 'utf-8'
        }, function (err, content) {
            if (err) {
                throw err;
            }
            var replaces = content.match(/url\(.*\)/gi);
            if (!replaces) {
                return;
            }
            var processCache = {};
            var processIndex = 0;

            // todo 没有清理注释，会导致把注释里的url也做处理
            replaces.forEach(function (original, idx) {
                if (processCache[original] === undefined) {
                    var processType = '';
                    var targetURL = '';
                    var imageURL = original.slice(4, -1)            // 去掉 url( 和 )
                                           .replace(/[\'\"]/gi, '') // 去掉引号
                                           .replace(/\?.*/gi, '');  // 去掉search，比如?__sprite todo:fixme

                    // 拿到的图片可能有4种情况：相对，绝对，内联，网络
                    // 相对：../../static/img/a.png 存在挪，不存在当bug
                    // 绝对：/tb/static-common/img.a.png [绝对也可能指向本模块地址] 本地看做相对，非本地看做网络
                    // 内联：data:[<mediatype>][;base64],<data> 或 about:blank 这种类型图片不做处理
                    // 网络：http://a.com/b.png 本域获取，非本域放过

                    // 这个大if只做是否存在的判断和目标url的拼写
                    if (imageURL.indexOf('/tb') === 0 || imageURL.indexOf('tb') === 0) {
                        if (imageURL[0] !== '/') {
                            imageURL = '/' + imageURL;
                        }
                        if (imageURL.indexOf(staticFolder) > -1) {
                            var tmp = imageURL.replace(staticFolder, staticPath);
                            if (fs.existsSync(tmp)) { // todo 比较existSync和在resourceExtension.index哪个快
                                processType = 'changePath';
                                targetURL = path.relative(root, tmp);
                            } else {
                                processType = 'download';
                                targetURL = httpStaticPath + imageURL;
                            }
                        } else {
                            processType = 'download';
                            targetURL = httpStaticPath + imageURL;
                        }
                    } else if (imageURL.indexOf('http://') === 0) {
                        if (tiebaDomain.indexOf(processFunctions.getDomain(imageURL)) > -1) {
                            processType = 'download';
                            targetURL = imageURL;
                        } else {
                            processType = 'ignore'; // 直接返回处理结果，不计入异步计数
                            targetURL = 'url(' + imageURL + ')';
                        }
                    } else if (imageURL.indexOf('about:') === 0 || imageURL.indexOf('data:') === 0) {
                        processType = 'ignore'; // 直接返回处理结果，不计入异步计数
                        targetURL = 'url(' + imageURL + ')';
                    } else {
                        imageURL = path.normalize(imageURL);
                        if (fs.existsSync(path.resolve(root, imageURL))) {
                            processType = 'changePath';
                            targetURL = imageURL;
                        } else {
                            // 这里有两种处理方式，其一是直接报错，其二是从网上找
                            console.error('引用的地址不存在@' + absPathWithFileName + '@' + original);
                            processType = 'ignore';
                            targetURL = original;
                        }
                    }

                    // 之所以分开两部分工作，是为了防止异步处理太快影响同步结果
                    if (processType !== 'ignore') {
                        if (!fs.existsSync(absImagesFolderPath)) { // todo 直接exist快还是加上一个标志位快
                            fs.mkdirSync(absImagesFolderPath);
                        }

                        setTimeout(function () {
                            processFunctions[processType](targetURL, original, absPathWithFileName);
                        }, 100);

                        processCache[original] = '';
                        processIndex++;
                    } else {
                        processCache[original] = targetURL;
                    }
                }
            });

            cssFileList[absPathWithFileName] = {
                fileName: fileName,
                root: root,
                processCache: processCache,
                processIndex: processIndex
            };
            cssFileCounter++;
        });
    } else if (referenceExtension.indexOf(fileExtName) > -1) {
        // 逻辑文件里的引用包含了变量、字符串拼接等方式，五花八门，还有拼用户头像这种误判
        // 如何判断资源的引用?
    }

    // goon
    next();
}).on('end', function () {
    // 好像也没啥可做的唉
});
